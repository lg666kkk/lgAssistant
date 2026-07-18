# 生产环境部署

本项目以 Node 20 Docker 容器运行。宿主机仅通过 Nginx 对外开放 80 和 443
端口；应用容器只绑定到 `127.0.0.1:3000`。

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
使用，但不会被复制进最终镜像。

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
2. 将 `deploy/nginx.conf` 复制到 `/etc/nginx/sites-available/personal-assistant`，并替换其中的 `example.com`。
3. 启用站点并申请证书：

```bash
ln -s /etc/nginx/sites-available/personal-assistant /etc/nginx/sites-enabled/personal-assistant
nginx -t && systemctl reload nginx
certbot --nginx -d example.com
```

云服务器安全组只应放行 SSH（22）、HTTP（80）和 HTTPS（443）。不要将 3000
端口暴露到公网。

## 更新部署

```bash
cd /opt/personal-assistant
git pull
docker compose up -d --build
```
