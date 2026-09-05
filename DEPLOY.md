# 生产环境部署

本项目以 Node 20 Docker 容器运行。宿主机仅通过 Nginx 对外开放 80 和 443
端口；应用容器只绑定到 `127.0.0.1:3000`。Compose 同时启动一个仅供应用
访问的 Redis 容器，并将其内存限制为 192 MB。

## 服务器准备

在选择 Docker 应用镜像的服务器上先检查 Buildx：

```bash
docker buildx version
```

Dockerfile 使用 BuildKit secret，密钥不会进入镜像层。若该命令不可用，请先为
服务器操作系统安装 `docker-buildx-plugin`，再继续后续步骤。

Ubuntu 系统镜像可使用以下命令安装部署工具：

```bash
apt-get update
apt-get install -y git nginx certbot python3-certbot-nginx docker-buildx-plugin
git clone <your-repository-url> /opt/personal-assistant
cd /opt/personal-assistant
cp .env.production.example .env.production
chmod 600 .env.production
```

将基础设施密钥填入 `.env.production`。LLM Provider 的 Base URL、API Key 和模型
不再放在环境变量中，由登录用户在「连接 → 大语言模型」里配置。`.env.production`
会在 Next.js 构建和容器运行时使用，但不会被复制进最终镜像。生产环境的 `REDIS_URL` 保持为
`redis://redis:6379`；不需要配置 `UPSTASH_REDIS_REST_URL` 或
`UPSTASH_REDIS_REST_TOKEN`。

启用运行时配置编辑前，将 `CONFIG_ADMIN_EMAILS` 设置为允许管理应用的 Supabase
登录邮箱，并生成加密主密钥：

```bash
openssl rand -base64 32
```

将生成结果填入 `CONFIG_ENCRYPTION_KEY`。使用设置页前，先在 Supabase SQL Editor
中执行 `docs/schemas/migrations/20260719-runtime-config.sql`。

Langfuse 使用独立的用户配置表。在 Supabase SQL Editor 中执行：

```text
docs/schemas/migrations/20260828-user-langfuse-config.sql
```

当前登录用户可在「连接 → 日志 → Langfuse 配置」中保存自己的 Base URL、Public Key
和 Secret Key。密钥使用 `CONFIG_ENCRYPTION_KEY` 加密，保存后下一次请求立即生效，
不再读取 `LANGFUSE_*` 环境变量，也不需要重启应用。

## 用户级模型配置

在 Supabase SQL Editor 中执行：

```text
docs/schemas/migrations/20260826-user-llm-config.sql
docs/schemas/migrations/20260826-user-llm-model-discovery.sql
docs/schemas/migrations/20260827-user-llm-tools-default.sql
```

这些迁移创建用户隔离的 Provider、模型、默认路由和审计表，并将早期通过模型发现
功能添加的模型统一初始化为支持工具调用。Provider API Key 使用
`CONFIG_ENCRYPTION_KEY` 进行 AES-256-GCM 加密，浏览器只会看到是否已配置及脱敏提示。
每个用户需要登录后在「连接 → 大语言模型」中至少配置一个启用模型，聊天和记忆
抽取才会调用模型。

## 用户级搜索引擎配置

在 Supabase SQL Editor 中执行：

```text
docs/schemas/migrations/20260827-user-search-config.sql
```

该迁移创建用户隔离的搜索 Provider 和默认路由表。Tavily、Exa、Brave Search 的
API Key 使用 `CONFIG_ENCRYPTION_KEY` 加密，浏览器不会读取密文。用户登录后可在
「连接 → 搜索引擎」中启用服务并选择默认 Provider。迁移期间服务器环境变量
`TAVILY_API_KEY`、`EXA_API_KEY`、`BRAVE_SEARCH_API_KEY` 仍可作为后备。

## 用户级记忆配置

在 Supabase SQL Editor 中执行：

```text
docs/schemas/migrations/20260828-user-memory-config.sql
```

该迁移创建用户隔离的记忆召回、写入和 Qwen3 Rerank 配置。用户可在「连接 → 集成
→ 记忆清单」中调整策略并查看当前记忆与历史版本。Rerank API Key 使用
`CONFIG_ENCRYPTION_KEY` 加密，不再读取 `MEMORY_RERANK_*` 生产环境变量。

## 聊天图片存储

多模态聊天的历史图片使用 Supabase Storage 私有 Bucket。首次启用前，在 Supabase
SQL Editor 中执行：

```text
docs/schemas/migrations/20260825-chat-images-storage.sql
```

该迁移创建 `chat-images` Bucket，并将读、写、删除权限限制在当前登录用户自己的
一级目录。应用只把 `storagePath` 保存到消息 metadata；Base64 和 Signed URL 不会
持久化到数据库。

## 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose exec redis redis-cli ping
docker compose logs -f app
```

开放公网反向代理前，先在服务器本机验证应用：

```bash
curl http://127.0.0.1:3000
```

## 定时任务

应用会保存定时任务，但生产环境需要外部每分钟调用一次 tick。VPS 使用仓库中的
systemd service/timer。辅助脚本只读取受保护 `.env.production` 中的
`CRON_SECRET`，密钥不写入 crontab、unit 或进程命令行：

```bash
sudo cp deploy/systemd/personal-assistant-scheduler.* /etc/systemd/system/
chmod 755 deploy/systemd/scheduler-tick.sh
sudo systemctl daemon-reload
sudo systemctl enable --now personal-assistant-scheduler.timer
systemctl list-timers personal-assistant-scheduler.timer
journalctl -u personal-assistant-scheduler.service -n 50 --no-pager
```

调度器使用 Supabase 原子领取到期任务。首次启用前必须执行
`docs/schemas/migrations/20260904-reliable-scheduler-channels.sql`。

## 域名与 HTTPS

1. 将域名 A 记录解析到服务器公网 IP。
2. 将 `deploy/nginx.conf` 复制到 `/etc/nginx/sites-available/personal-assistant`。
3. 启用站点并申请证书：

```bash
ln -s /etc/nginx/sites-available/personal-assistant /etc/nginx/sites-enabled/personal-assistant
nginx -t && systemctl reload nginx
certbot --nginx --redirect -d aicharleslg.com -d www.aicharleslg.com
```

`deploy/nginx.conf` 已配置 `aicharleslg.com` 和 `www.aicharleslg.com`，初始监听
HTTP 80 端口。`certbot --nginx --redirect` 会申请两个域名的证书、补充 443
HTTPS 配置，并将 HTTP 请求重定向到 HTTPS。执行 Certbot 前请确保两个域名都已
解析到本机且安全组放行 80/443 端口。

云服务器安全组只应放行 SSH（22）、HTTP（80）和 HTTPS（443）。不要将 3000
或 6379 端口暴露到公网。Redis 没有配置宿主机端口映射，只通过 Compose 私有网络
接收应用连接。

## 更新部署

```bash
cd /opt/personal-assistant
git pull
docker compose up -d --build
```
