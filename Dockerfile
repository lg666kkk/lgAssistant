# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Next.js needs these variables while compiling server routes and client config.
# BuildKit mounts the file only for this command; it is not copied into an image layer.
RUN --mount=type=secret,id=app_env,target=/app/.env.local npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ARG DEBIAN_MIRROR=https://mirrors.cloud.tencent.com

# Bootstrap HTTPS trust from Node's bundled CA roots in the slim image.
RUN node -e 'const fs = require("fs"); fs.mkdirSync("/etc/ssl/certs", { recursive: true }); fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("tls").rootCertificates.join("\n") + "\n")' \
  && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Retries "3";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-download-retries \
  && apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /app/data/agent-artifacts \
  && chown -R nextjs:nodejs /app

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
