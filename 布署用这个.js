const DEFAULT_SETTINGS = {
  model: "@cf/meta/llama-3-8b-instruct", // 默认模型
};

export default {
  async fetch(request, env) {
    // 1. 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    // 2. 身份验证
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_SECRET_KEY}`;
    
    if (!env.API_SECRET_KEY || authHeader !== expectedAuth) {
      return new Response(JSON.stringify({
        error: { message: "Invalid API Key", type: "invalid_request_error" }
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const url = new URL(request.url);
    
    // 3. 路由匹配: /v1/chat/completions
    if (request.method === "POST" && url.pathname.endsWith("/v1/chat/completions")) {
      return await handleChat(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * 处理聊天逻辑
 */
async function handleChat(request, env) {
  try {
    const body = await request.json();
    const {
      messages,
      model = env.DEFAULT_MODEL || DEFAULT_SETTINGS.model,
      stream = false,
      max_tokens = 2048,
      temperature = 0.7
    } = body;

    // 调用 Cloudflare Workers AI
    const aiResponse = await env.AI.run(model, {
      messages,
      stream,
      max_tokens,
      temperature
    });

    // 处理流式响应
    if (stream) {
      return makeStreamResponse(aiResponse, model);
    }

    // 处理非流式响应
    return new Response(JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: aiResponse.response,
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), {
      headers: { 
        "Content-Type": "application/json",
        ...getCorsHeaders()
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

/**
 * 将 Cloudflare 的流格式转换为 OpenAI 兼容的 SSE 格式
 */
function makeStreamResponse(aiStream, model) {
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
        // Cloudflare 的流返回的是类似 { response: "..." } 的 JSON 字符串
        // 需要解析并包装
        try {
          const lines = chunk.split('\n').filter(line => line.trim());
          for (let line of lines) {
            if (line.startsWith('data:')) {
              const data = JSON.parse(line.replace('data: ', ''));
              const payload = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: data.response },
                  finish_reason: null
                }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
          }
        } catch (e) {
          console.error("Error parsing chunk", e);
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
      "Connection": "keep-alive",
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
