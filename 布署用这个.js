const MODEL_MAPPING = {
  "gpt oss 120b": "@cf/openai/gpt-oss-120b",
  "llama4": "@cf/meta/llama-4-scout-17b-16e-instruct"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return handleCors();
    const authHeader = request.headers.get("Authorization");
    if (!env.API_SECRET_KEY || authHeader !== `Bearer ${env.API_SECRET_KEY}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/v1/chat/completions")) {
      return await handleChat(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
};

// 核心：多维度提取文本，支持思维链 (Reasoning)
function extractText(obj) {
  if (!obj) return "";
  if (typeof obj === 'string') return obj;

  const choices = obj.choices?.[0];
  const msg = choices?.message || choices?.delta || obj.message || obj.delta || {};
  
  // 按照优先级抓取：内容 > 推理内容 > 其他可能字段
  return String(
    msg.content || 
    msg.reasoning_content || 
    obj.response || 
    obj.result || 
    ""
  );
}

async function handleChat(request, env) {
  try {
    const body = await request.json();
    let model = body.model || env.DEFAULT_MODEL || "@cf/meta/llama-3.1-8b-instruct";
    
    const lowerModel = model.toLowerCase().trim();
    if (MODEL_MAPPING[lowerModel]) {
      model = MODEL_MAPPING[lowerModel];
    }

    const isStream = body.stream === true;
    const requestId = `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
    const createdTime = Math.floor(Date.now() / 1000);

    // 调用 AI 引擎
    const aiResponse = await env.AI.run(model, {
      messages: body.messages,
      stream: isStream,
      // 120B 这种模型很话痨，建议把 max_tokens 稍微拉高一点
      max_tokens: body.max_tokens || 4096, 
    });

    if (isStream) {
      return makeStreamResponse(aiResponse, model, requestId, createdTime);
    }

    const result = await aiResponse;
    let finalContent = extractText(result);

    // 如果还是没抓到，给个提示
    if (!finalContent) finalContent = "[Worker提示] 模型响应成功但内容字段缺失";

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
    return new Response(JSON.stringify({ error: String(e.message) }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...getCorsHeaders() } 
    });
  }
}

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
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
        
        for (let line of lines) {
          const jsonStr = line.replace('data: ', '').trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = extractText(parsed);
            if (content) {
              const payload = {
                id: requestId,
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                choices: [{ index: 0, delta: { content: content }, finish_reason: null }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
          } catch (e) {}
        }
      }
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", ...getCorsHeaders() }
  });
}

function handleCors() {
  return new Response(null, { status: 204, headers: getCorsHeaders() });
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
