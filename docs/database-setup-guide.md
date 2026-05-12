# Supabase 数据库初始化指南

## 方式一：通过 Supabase Dashboard（推荐）

### 步骤 1: 打开 Supabase Dashboard

1. 访问 https://supabase.com/dashboard
2. 登录你的账号
3. 选择你的项目

### 步骤 2: 进入 SQL Editor

1. 在左侧菜单找到 **SQL Editor**
2. 点击 **New query** 创建新查询

### 步骤 3: 执行 SQL

1. 打开 `docs/database-schema.sql` 文件
2. 复制全部内容
3. 粘贴到 SQL Editor
4. 点击右下角的 **Run** 按钮

### 步骤 4: 验证结果

执行成功后，你应该看到：

```
Success. No rows returned
```

然后在左侧菜单进入 **Table Editor**，你应该能看到：
- ✅ `notion_pages` 表
- ✅ `documents` 表

---

## 方式二：通过命令行（需要 Supabase CLI）

### 安装 Supabase CLI

```bash
npm install -g supabase
```

### 登录

```bash
supabase login
```

### 链接项目

```bash
supabase link --project-ref <你的项目ID>
```

### 执行 SQL

```bash
supabase db push --db-url "postgresql://postgres:[密码]@[项目URL]:5432/postgres" < docs/database-schema.sql
```

---

## 验证数据库结构

执行完成后，运行以下查询验证：

```sql
-- 1. 检查表是否创建成功
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('notion_pages', 'documents');

-- 2. 检查 pgvector 扩展
SELECT * FROM pg_extension WHERE extname = 'vector';

-- 3. 检查索引
SELECT indexname, tablename 
FROM pg_indexes 
WHERE schemaname = 'public' 
AND tablename IN ('notion_pages', 'documents');

-- 4. 检查 RPC 函数
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_name IN ('match_documents', 'need_sync_pages');
```

预期结果：
- 2 个表
- 1 个扩展（vector）
- 4 个索引
- 2 个函数

---

## 常见问题

### Q1: pgvector 扩展不存在

**错误信息：**
```
ERROR: extension "vector" is not available
```

**解决方案：**
在 Supabase Dashboard > Database > Extensions 中启用 `vector` 扩展。

### Q2: 权限不足

**错误信息：**
```
ERROR: permission denied to create extension "vector"
```

**解决方案：**
确保使用的是 `SUPABASE_SERVICE_ROLE_KEY`，而不是 `SUPABASE_ANON_KEY`。

### Q3: 表已存在

**错误信息：**
```
ERROR: relation "notion_pages" already exists
```

**解决方案：**
SQL 中使用了 `IF NOT EXISTS`，这个错误不应该出现。如果出现，说明表已经创建成功了。

---

## 下一步

数据库初始化完成后：

1. ✅ 实现 Notion 同步模块
2. ✅ 实现文本切块模块
3. ✅ 测试向量检索功能
