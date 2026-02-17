export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // CORS 预检
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      }

      // 仅允许 POST /v1/chat/completions
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return new Response('Not Found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      // 认证
      const auth = request.headers.get('Authorization');
      if (!auth || auth !== `Bearer ${env.API_SECRET_KEY}`) {
        return new Response('Unauthorized', { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      // 解析请求体
      const body = await request.json();
      const { messages, stream = false, model = env.DEFAULT_MODEL || '@cf/meta/llama-3-8b-instruct' } = body;

      // 调用 AI
      const aiResponse = await env.AI.run(model, { messages, stream });

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      // 流式响应
      if (stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          try {
            const reader = aiResponse.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = new TextDecoder().decode(value);
              let content = '';
              let usage = null;

              // 尝试解析 JSON，提取 response 字段
              try {
                const parsed = JSON.parse(chunk);
                if (parsed.response) content = parsed.response;
                if (parsed.usage) usage = parsed.usage;
              } catch {
                // 不是 JSON，直接作为文本
                content = chunk;
              }

              // 构建 OpenAI 标准 SSE 消息
              const sseMessage = {
                id: crypto.randomUUID(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: content ? [{
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                }] : [],
              };
              if (usage) sseMessage.usage = usage;

              // 如果没有内容和 usage，跳过（避免空消息）
              if (sseMessage.choices.length === 0 && !usage) continue;

              await writer.write(encoder.encode(`data: ${JSON.stringify(sseMessage)}\n\n`));
            }
            // 发送结束标记
            await writer.write(encoder.encode('data: [DONE]\n\n'));
          } catch (err) {
            // 流处理错误
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: { 'Content-Type': 'text/event-stream', ...corsHeaders },
        });
      }

      // 非流式响应
      const answer = typeof aiResponse === 'object' && aiResponse.response ? aiResponse.response : String(aiResponse);
      const result = {
        id: crypto.randomUUID(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: answer },
          finish_reason: 'stop',
        }],
      };
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
