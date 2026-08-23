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

将已有的服务商密钥填入 `.env.production`。该文件会在 Next.js 构建和容器运行时
使用，但不会被复制进最终镜像。生产环境的 `REDIS_URL` 保持为
`redis://redis:6379`；不需要配置 `UPSTASH_REDIS_REST_URL` 或
`UPSTASH_REDIS_REST_TOKEN`。

启用运行时配置编辑前，将 `CONFIG_ADMIN_EMAILS` 设置为允许管理应用的 Supabase
登录邮箱，并生成加密主密钥：

```bash
openssl rand -base64 32
```

将生成结果填入 `CONFIG_ENCRYPTION_KEY`。使用设置页前，先在 Supabase SQL Editor
中执行 `docs/schemas/migrations/20260719-runtime-config.sql`。

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

应用会保存定时任务，但生产环境需要外部每分钟调用一次 tick。使用 `crontab -e`
新增下面的任务，并将 `YOUR_CRON_SECRET` 替换为 `.env.production` 中的
`CRON_SECRET`：

```cron
* * * * * /usr/bin/curl -fsS -H "x-cron-secret: YOUR_CRON_SECRET" http://127.0.0.1:3000/api/cron/tick >/dev/null
```

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
