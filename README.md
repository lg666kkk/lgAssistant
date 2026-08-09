# Personal Assistant

这是一个使用 Next.js App Router、TypeScript 和 Tailwind CSS 搭建的个人智能助手项目。

RAG 是该项目中的一个子模块，用于支持知识检索、上下文增强和问答能力；后续项目会继续增加更多智能助手能力。

## 环境变量配置

在项目根目录创建 `.env.local` 文件，配置以下必需的环境变量：

```bash
# DeepSeek API 配置
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1  # 可选，默认使用官方地址

# Supabase 数据库配置
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Local Redis used by the development server
REDIS_URL=redis://127.0.0.1:6379
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## 开始使用

安装依赖：

```bash
npm install
```

启动本地 Redis：

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec redis redis-cli ping
```

第二条命令返回 `PONG` 后再启动开发服务器。Redis 只绑定到
`127.0.0.1:6379`，不会暴露到局域网或公网。

启动开发服务器：

```bash
npm run dev
```

打开浏览器访问：

```text
http://localhost:3000
```

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run lint
docker compose -f docker-compose.dev.yml down
```
