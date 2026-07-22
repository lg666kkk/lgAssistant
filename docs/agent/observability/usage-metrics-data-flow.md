# Usage 页面数据来源与计算口径

## 总览

`/usage` 页面展示的是模型调用用量、缓存命中和费用估算。它的数据不是从 DeepSeek 的账单明细接口直接拉取，而是来自本项目每次模型调用后落库的 `agent_traces`。

整体链路：

```text
模型响应 usage
  -> runAgentLoop 解析为 ModelUsageBreakdown
  -> 写入 trace.steps[].usage 和 trace.metrics
  -> saveTrace 落库 agent_traces
  -> /api/usage 从 agent_traces 聚合
  -> /usage 页面展示
```

另外，DeepSeek 账户余额来自单独接口：

```text
GET /api/deepseek/balance
  -> DeepSeek GET https://api.deepseek.com/user/balance
```

因此 `/usage` 页面有两类数据：

| 数据 | 来源 | 性质 |
|---|---|---|
| token 用量 | 模型响应 `usage`，落库到 `agent_traces` | 真实调用数据 |
| 费用 | 本地价格表 × token 用量 | 本地估算 |
| DeepSeek 余额 | DeepSeek `/user/balance` | 官方余额接口 |
| 最近请求 | `agent_traces` | 本地 trace 记录 |

---

## 采集位置

模型调用发生在：

```text
lib/agent/runtime/index.ts
```

每次 `callModel(...)` 返回后，会读取：

```ts
initialResponse.usage
```

当前项目使用 Anthropic SDK 调 DeepSeek 的 Anthropic 兼容接口：

```ts
const client = new Anthropic({
  apiKey: deepseekConfig.apiKey,
  baseURL: deepseekConfig.baseURL,
});
```

默认 baseURL：

```text
https://api.deepseek.com/anthropic
```

所以实际返回的 usage 字段可能是 Anthropic 兼容格式。

---

## DeepSeek 缓存字段映射

DeepSeek 原生文档中的字段是：

```ts
usage.prompt_cache_hit_tokens
usage.prompt_cache_miss_tokens
```

当前 Anthropic 兼容接口实际可能返回：

```ts
usage.cache_read_input_tokens
usage.cache_creation_input_tokens
usage.input_tokens
usage.output_tokens
```

项目里做了兼容解析：

```ts
cacheHitTokens =
  rawUsage.prompt_cache_hit_tokens ??
  rawUsage.cache_read_input_tokens;

cacheMissTokens = rawUsage.prompt_cache_miss_tokens;

cacheCreationTokens = rawUsage.cache_creation_input_tokens;
```

字段含义：

| 页面字段 | DeepSeek 原生字段 | Anthropic 兼容字段 | 含义 |
|---|---|---|---|
| 缓存读取 | `prompt_cache_hit_tokens` | `cache_read_input_tokens` | 本次输入中命中缓存的 tokens |
| 普通输入 | `prompt_cache_miss_tokens` | `input_tokens` | 本次输入中未命中缓存、按普通输入计费的 tokens |
| 缓存创建 | 无直接等价 | `cache_creation_input_tokens` | 本次写入缓存的 tokens |
| 输出 | `completion_tokens` 或 `output_tokens` | `output_tokens` | 模型生成的 tokens |

一个真实日志例子：

```ts
{
  input_tokens: 84,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1408,
  output_tokens: 212,
  service_tier: "standard"
}
```

解释：

```text
普通输入：84
缓存读取：1408
缓存创建：0
输出：212
```

---

## 单次模型调用的计算

计算函数在：

```text
lib/agent/models.ts
```

核心类型：

```ts
type ModelUsageBreakdown = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  estimatedCostCny: number;
  inputCacheHitCostCny: number;
  inputCacheMissCostCny: number;
  outputCostCny: number;
};
```

### inputTokens

页面中的“输入”不是简单等于原始 `usage.input_tokens`。

在 Anthropic 兼容接口里：

```text
input_tokens = 未命中缓存的普通输入部分
cache_read_input_tokens = 命中缓存读取部分
cache_creation_input_tokens = 新创建缓存部分
```

项目当前口径：

```ts
inputTokens = cacheMissTokens + cacheHitTokens;
```

其中：

```ts
cacheMissTokens = prompt_cache_miss_tokens ?? input_tokens + cache_creation_input_tokens
cacheHitTokens = prompt_cache_hit_tokens ?? cache_read_input_tokens
```

### outputTokens

```ts
outputTokens = rawUsage.output_tokens
```

即模型实际生成的 tokens。

### totalTokens

```ts
totalTokens = inputTokens + outputTokens
```

这是页面上的“真实总 tokens”。

### cacheHitRate

```ts
cacheHitRate =
  cacheHitTokens / (cacheHitTokens + cacheMissTokens)
```

注意：这里不把 `outputTokens` 放进分母，因为缓存只作用于输入前缀。

### estimatedCostCny

费用是本地估算，不是 DeepSeek 账单接口返回的扣费。

价格表在：

```text
lib/agent/models.ts
```

当前配置：

```ts
deepseek-v4-flash: {
  inputCacheHit: 0.02,
  inputCacheMiss: 1,
  output: 2,
}

deepseek-v4-pro: {
  inputCacheHit: 0.025,
  inputCacheMiss: 3,
  output: 6,
}
```

单位是：

```text
CNY / 1M tokens
```

计算公式：

```ts
inputCacheHitCostCny =
  cacheHitTokens / 1_000_000 * inputCacheHitPrice;

inputCacheMissCostCny =
  cacheMissTokens / 1_000_000 * inputCacheMissPrice;

outputCostCny =
  outputTokens / 1_000_000 * outputPrice;

estimatedCostCny =
  inputCacheHitCostCny + inputCacheMissCostCny + outputCostCny;
```

---

## Trace 落库内容

每次模型调用会写入一个 model step：

```ts
{
  type: "model",
  model: "deepseek-v4-pro",
  usage: {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens,
    cacheHitRate,
    estimatedCostCny,
    inputCacheHitCostCny,
    inputCacheMissCostCny,
    outputCostCny
  }
}
```

每次 agent loop 还会累计 `trace.metrics`：

```ts
{
  modelCallCount,
  actualInputTokens,
  actualOutputTokens,
  actualTotalTokens,
  cacheHitTokens,
  cacheMissTokens,
  estimatedModelCostCny,
  toolCallCount,
  totalToolCost
}
```

落库位置：

```text
lib/agent/runtime/trace-store.ts
```

表：

```text
agent_traces
```

其中：

```text
steps   JSONB
metrics JSONB
```

---

## /api/usage 聚合方式

API 文件：

```text
app/api/usage/route.ts
```

请求示例：

```text
GET /api/usage?limit=1000&page=1&pageSize=20
```

参数：

| 参数 | 说明 |
|---|---|
| `limit` | 从最新 trace 中取多少条参与聚合，最大 1000 |
| `page` | 最近请求表格当前页 |
| `pageSize` | 最近请求每页条数，范围 5-100 |

聚合流程：

```text
读取 agent_traces
  -> 遍历每条 trace.steps
  -> 只处理 type === "model" 且存在 usage 的 step
  -> 按 step.model 聚合为 models
  -> 所有 model 汇总成 total
  -> 每条 trace 汇总成 recentRequests
  -> 对 recentRequests 分页
```

返回结构：

```ts
{
  total,
  models,
  recentRequests,
  pagination,
  knownModels
}
```

---

## 页面字段说明

页面文件：

```text
app/usage/page.tsx
```

### DeepSeek 余额

来源：

```text
GET /api/deepseek/balance
```

上游接口：

```text
GET https://api.deepseek.com/user/balance
```

字段：

| 页面字段 | DeepSeek 字段 | 含义 |
|---|---|---|
| 总余额 | `total_balance` | 当前可用余额 |
| 充值余额 | `topped_up_balance` | 用户充值余额 |
| 赠送余额 | `granted_balance` | 平台赠送余额 |
| 可用/不可用 | `is_available` | 当前余额是否可继续 API 调用 |

### 估算总费用

来源：

```ts
total.estimatedCostCny
```

含义：当前统计范围内所有模型调用的估算费用总和。

### 真实总 tokens

来源：

```ts
total.totalTokens
```

公式：

```text
真实总 tokens = 输入 tokens + 输出 tokens
```

### 缓存命中率

来源：

```ts
total.cacheHitRate
```

公式：

```text
缓存命中率 = 缓存读取 / (缓存读取 + 普通输入)
```

### 模型调用

来源：

```ts
total.modelCallCount
```

含义：模型 API 被调用的次数。

一次用户请求可能有多次模型调用：

```text
模型判断要调工具
  -> 执行工具
  -> 模型读取工具结果继续回答
```

所以：

```text
模型调用数 >= 用户请求数
```

### 总量构成

页面条形图展示：

```text
缓存读取
缓存创建
普通输入
输出
```

其中：

| 项 | 含义 |
|---|---|
| 缓存读取 | 命中缓存的输入 tokens |
| 缓存创建 | 本次写入缓存的 tokens |
| 普通输入 | 未命中缓存、按普通输入价格计费的 tokens |
| 输出 | 模型生成的 tokens |

### 按模型拆分

来源：

```ts
models[]
```

每个模型分别累计：

```text
requestCount
modelCallCount
inputTokens
outputTokens
cacheHitTokens
cacheMissTokens
cacheCreationTokens
estimatedCostCny
```

旧 trace 如果没有 `step.model`，会归入：

```text
unknown
```

### 最近请求

来源：

```ts
recentRequests[]
```

每一行对应一条 `agent_traces` 记录，也就是一次 `/api/chat` 请求。

字段：

| 列 | 来源 | 含义 |
|---|---|---|
| 时间 | `trace.created_at` | 请求发生时间 |
| 会话 | `sessions.title` | 会话标题 |
| 模型 | 第一个 model step 的 `model` | 本次请求主要模型 |
| Tokens | 该 trace 下所有 model step 的 `totalTokens` 总和 |
| 费用 | 该 trace 下所有 model step 的 `estimatedCostCny` 总和 |

分页：

```ts
pagination: {
  page,
  pageSize,
  totalItems,
  totalTraceCount,
  hasPreviousPage,
  hasNextPage
}
```

---

## 旧数据兼容

旧 trace 可能只有：

```ts
usage: {
  inputTokens,
  outputTokens
}
```

缺少：

```text
model
cacheHitTokens
cacheMissTokens
cacheCreationTokens
estimatedCostCny
```

兼容策略：

```text
缺 model -> 归入 unknown
缺 cacheHitTokens -> 按 0 处理
缺 cacheMissTokens -> 用 inputTokens 推导
缺 estimatedCostCny -> 按当前价格表重新估算
```

因此旧数据在 `/usage` 页面里可能表现为：

```text
模型 unknown
缓存命中 0%
费用为按当前价格表回算
```

如果要让页面完全干净，可以清空旧 `agent_traces` 后重新生成新 trace。

---

## 注意事项

1. **费用是估算值**

   DeepSeek 余额来自官方接口，但 usage 页的“估算总费用”不是账单接口返回值，而是本地价格表计算值。

2. **价格表需要维护**

   如果 DeepSeek 调整价格，需要更新：

   ```text
   lib/agent/models.ts
   ```

3. **缓存命中只作用于输入**

   输出 tokens 永远不是缓存读取。相同输入仍可能因为 temperature 等参数产生不同输出。

4. **缓存是 best-effort**

   DeepSeek 文档说明缓存系统是尽力而为，不保证 100% 命中。

5. **接口格式会影响 usage 字段**

   DeepSeek 原生接口和 Anthropic 兼容接口返回的 cache 字段名不同，本项目目前做了双字段兼容。

6. **limit 影响总览范围**

   `/api/usage?limit=1000` 只聚合最新 1000 条 trace，不代表数据库全量历史。
