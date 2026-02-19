# cf-worker-ai-js
这是一个适用于Cloudflare worker的js代码，用于在worker上运行兼容openAI的LLM API

注意:这个代码并不完美，请帮助改善

## 1.使用方法

将`布署用这个.js`的内容复制下来，粘贴到你的Cloudflare worker里，然后布署

## 2.填写及绑定

`API_SECRET_KEY`：填写你的API tocken值，一定要记住

`DEFAULT_MODEL`:（可选）默认模型，在调用的时候可以不填写模型，如果填写了会覆盖这个。模型名称详见https://developers.cloudflare.com/workers-ai/models/

绑定workers AI，名为`AI`

## 3.调用

API类型/提供商: OpenAI-Compatible （或 Generic OpenAI ，确保选择与 OpenAI API 格式兼容的选项）

API 密钥 (API Key) 这是你在 Cloudflare 环境变量中设置的 API_SECRET_KEY 的值。

API 地址 (API URL) `https://你的worker域名或者自定义域名/v1/chat/completions`

注意：如果调用失败，可以把后面的`/chat/completions`删掉，直接以v1一结尾，某些调用器会自动补全后面那一段，例如Nyarch Assistant
