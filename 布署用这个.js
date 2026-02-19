const MODEL_MAPPING = {
  "gpt oss 120b": "@cf/openai/gpt-oss-120b",
  "llama4": "@cf/meta/llama-4-scout-17b-16e-instruct"
};

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return handleCors();

    // 身份验证
    const authHeader = request.headers.get("Authorization");
    if (!env.API_SECRET_KEY || authHeader !== `Bearer ${env.API_SECRET_KEY}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        status: 401, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/v1/chat/completions")) {
      return await handleChat(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * 核心：文本提取函数
 * @param {Object} obj - 模型返回的 JSON 片段
 * @param {Boolean} isStream - 是否为流式传输模式
 */
function extractText(obj, isStream = false) {
  if (!obj) return "";
  const choices = obj.choices?.[0];
  const msg = choices?.message || choices?.delta || obj.message || obj.delta || {};

  // 如果是流式传输，只抓取真正的 content，忽略 reasoning_content
  if (isStream) {
    return String(msg.content || "");
  }

  // 如果是非流式，优先抓 content，如果没有再抓推理内容兜底
  return String(msg.content || msg.reasoning_content || obj.response || obj.result || "");
}

async function handleChat(request, env) {
  try {
    const body = await request.json();
    let model = body.model || env.DEFAULT_MODEL || DEFAULT_MODEL;
    
    // 模型名称智能映射
    const lowerModel = model.toLowerCase().trim();
    if (MODEL_MAPPING[lowerModel]) {
      model = MODEL_MAPPING[lowerModel];
    }

    const isStream = body.stream === true;
    const requestId = `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
    const createdTime = Math.floor(Date.now() / 1000);

    // 调用 Cloudflare AI
    const aiResponse = await env.AI.run(model, {
      messages: body.messages,
      stream: isStream,
      max_tokens: body.max_tokens || 4096, // 调高默认 Token 以防被掐断
    });

    if (isStream) {
      return makeStreamResponse(aiResponse, model, requestId, createdTime);
    }

    // --- 非流式响应处理 ---
    const result = await aiResponse;
    const finalContent = extractText(result, false);

    return new Response(JSON.stringify({
      id: String(requestId),
      object: "chat.completion",
      created: createdTime,
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: finalContent },
        finish_reason: result.choices?.[0]?.finish_reason || "stop",
      }],
      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), { headers: { "Content-Type": "application/json", ...getCorsHeaders() } });

  } catch (e) {
    return new Response(JSON.stringify({ error: `Worker Error: ${e.message}` }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...getCorsHeaders() } 
    });
  }
}

/**
 * 处理流式响应：过滤内心戏，只留正文
 */
function makeStreamResponse(aiStream, model, requestId, createdTime) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = aiStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (let line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.replace('data: ', '').trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = extractText(parsed, true);

            // 关键：只有当内容非空（正式回复开始）时才推送到前端
            if (content && content !== "undefined") {
              const payload = {
                id: String(requestId),
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: String(content) },
                  finish_reason: null
                }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
          } catch (e) {
            // 解析失败通常是数据包断裂，跳过即可
          }
        }
      }
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...getCorsHeaders()
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders()
  });
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
