# Ollama 本地模型

语言模型仍使用 OpenAI-compatible 协议，无需数据库迁移。

## 本机开发

1. 启动 Ollama，并安装需要的模型（用 `ollama list` 查看）。
2. 使用 `npm run dev` 启动项目。
3. 在「连接 → 语言模型」点击「+ Ollama」。默认地址为 `http://localhost:11434/v1`，API Key 自动填写占位值 `ollama`。
4. 点击「获取模型列表」，选择已安装模型并添加；也可以手动填写 `ollama list` 中的完整模型名称。
5. Ollama 预设添加的模型默认关闭工具调用和图片支持，在模型配置里按实际模型能力开启并设置上下文容量，保存后测试连接，在聊天模型选择器中选用。

本地模型加载可能较慢，连接测试和聊天 HTTP 请求允许等待最多 180 秒（收到响应头后不限制整个生成时长）。Ollama 本地接口不要求真实 API Key，项目使用占位值以兼容已有凭据存储。

## 生产、Docker 与远程 Ollama

模型请求由应用服务端发出。云服务器上的 localhost 指向云服务器；Docker 容器中的 localhost 指向容器自身。

生产环境需要在服务端环境变量中显式设置可信 API 地址，并重启应用：

```dotenv
LLM_LOCAL_BASE_URLS=http://ollama:11434/v1
```

本机开发默认允许 `localhost`、`127.0.0.1`、`[::1]` 的任意端口，可以直接在界面填写 `http://127.0.0.1:8008/v1` 等地址，无需逐个授权端口。`LLM_LOCAL_BASE_URLS` 不会覆盖这个本机规则。

生产环境若需要连接本机任意端口的模型服务，可以设置：

```dotenv
LLM_ALLOW_LOCALHOST=true
```

设置 `LLM_ALLOW_LOCALHOST=false` 可关闭自动本机访问（开发环境同样适用）。额外的内网地址、Docker 服务名通过 `LLM_LOCAL_BASE_URLS` 指定，可使用逗号分隔多个完整 Base URL，允许末尾斜线。修改环境变量后重新加载开发服务；生产环境需要重启应用。

Docker Desktop 访问宿主机可以使用 `http://host.docker.internal:11434/v1`，Linux Docker 需要自行配置宿主机网关或使用同网络的 Ollama 容器。Ollama 必须监听应用能访问的网络接口。云端应用连接个人电脑时，需要先建立服务端可达的私有网络通道，再配置地址。

白名单仅适用于语言模型的保存、模型发现、连接测试和聊天调用。MCP 等其他服务仍遵守原来的公网地址限制。本地模型调用只允许配置的 API 路径下的请求，不允许跳转。

模型列表中的模型必须支持 Chat Completions 才能用于聊天。Whisper ASR 和 Kokoro TTS 等音频模型需要对应的音频接口，不能作为聊天模型使用。
