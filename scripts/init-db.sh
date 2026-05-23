#!/bin/bash

# Supabase 数据库初始化脚本

echo "=== Supabase 数据库初始化 ==="
echo ""

# 加载环境变量
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
  echo "✅ 环境变量加载成功"
else
  echo "❌ 找不到 .env.local 文件"
  exit 1
fi

# 检查必需的环境变量
if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ]; then
  echo "❌ 缺少 NEXT_PUBLIC_SUPABASE_URL"
  exit 1
fi

if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "❌ 缺少 SUPABASE_SERVICE_ROLE_KEY"
  echo ""
  echo "请在 .env.local 中添加："
  echo "SUPABASE_SERVICE_ROLE_KEY=你的service_role密钥"
  echo ""
  echo "获取方式："
  echo "1. 打开 https://supabase.com/dashboard"
  echo "2. 选择你的项目"
  echo "3. 进入 Settings > API"
  echo "4. 复制 service_role key (secret)"
  exit 1
fi

echo "✅ 环境变量检查通过"
echo ""
echo "Supabase URL: $NEXT_PUBLIC_SUPABASE_URL"
echo ""
echo "⚠️  由于 Supabase 客户端不支持直接执行 DDL，请手动执行："
echo ""
echo "1. 打开 https://supabase.com/dashboard"
echo "2. 选择你的项目"
echo "3. 进入 SQL Editor"
echo "4. 复制 docs/schemas/database-schema.sql、docs/schemas/leetcode-practice-schema.sql、docs/schemas/leetcode-wrong-book-schema.sql 的内容"
echo "5. 粘贴并点击 Run"
echo ""
echo "或者使用以下命令查看 SQL 内容："
echo "cat docs/schemas/*.sql"
