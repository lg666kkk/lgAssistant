# Web Fetch 工具完美实现方案

## 目标定位

`web_fetch` 不是搜索工具，而是网页精读工具。它的职责是：给定一个明确 URL，安全地读取公开网页内容，提取正文，压缩成适合模型使用的 evidence，并保留可追溯 metadata。

它应该和 `web_search` 分工协作：

```text
web_search：发现候选来源，返回标题、URL、摘要、发布时间、相关度
web_fetch：读取指定 URL，提取正文、标题、作者、发布时间、关键片段
```

理想调用链路：

```text
用户问题
  -> 模型判断需要联网
  -> web_search 搜索 3-5 条候选结果
  -> 模型选择 1-2 个最高价值 URL
  -> web_fetch 精读网页正文
  -> 模型基于正文回答，并引用来源
```

核心原则不是“把整个网页塞进上下文”，而是“把可信、干净、紧凑、可追溯的正文证据交给模型”。

---

## 一句话架构

`web_fetch` 应该由五层组成：

```text
Input Validation
  -> URL Safety Guard
  -> HTTP Fetch
  -> Content Extraction
  -> Evidence Compression
  -> ToolResult + Sources Metadata
```

每一层都要独立可测。不要把 URL 校验、fetch、HTML 清洗、正文压缩全写在一个 `execute` 函数里。

---

## 工具契约

### 输入类型

```ts
export type WebFetchInput = {
  url: string;
  maxChars?: number;
  extractMode?: "article" | "text" | "metadata";
};
```

字段说明：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `url` | `string` | 必填 | 要读取的公开网页 URL，只允许 `http` / `https` |
| `maxChars` | `number` | `8000` | 返回给模型的正文最大字符数，建议上限 `20000` |
| `extractMode` | union | `article` | `article` 优先提取正文，`text` 返回清洗文本，`metadata` 只读标题/描述等 |

### Tool Schema

```ts
input_schema: {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "要读取的公开网页 URL，必须是 http 或 https",
    },
    maxChars: {
      type: "number",
      description: "返回正文的最大字符数，默认 8000，最多 20000",
    },
    extractMode: {
      type: "string",
      enum: ["article", "text", "metadata"],
      description: "提取模式，默认 article",
    },
  },
  required: ["url"],
  additionalProperties: false,
}
```

### 输出类型

```ts
type WebFetchData = {
  url: string;
  finalUrl: string;
  title?: string;
  byline?: string;
  siteName?: string;
  publishedAt?: string;
  description?: string;
  contentType?: string;
  status: number;
  text: string;
  excerpt: string;
  originalChars: number;
  returnedChars: number;
  truncated: boolean;
};
```

`ToolResult.content` 给模型看，应该是紧凑文本：

```text
标题：...
来源：...
发布时间：...
链接：...

正文摘录：
...
```

`ToolResult.data` 给程序和 trace 用，保留结构化字段。不要只返回一坨字符串。

---

## 文件设计

建议新增：

```text
lib/agent/tools/web-fetch.ts
lib/agent/tools/web-fetch.test.ts
```

可选拆分：

```text
lib/agent/tools/web-fetch/
  index.ts
  input.ts
  url-safety.ts
  fetch-page.ts
  extract.ts
  format.ts
```

当前项目规模下，第一版可以先用单文件，但内部函数要分层：

```ts
parseInput(input)
validatePublicHttpUrl(url)
fetchWithLimits(url)
extractReadableContent(html, url)
formatWebFetchResult(result)
```

注册位置：

```text
lib/agent/tools/builtin.ts
```

```ts
import { webFetchTool } from "./web-fetch";

registry.register(webFetchTool);
```

---

## 推荐依赖

完美实现不建议只用正则清洗 HTML。正则版适合 Demo，但真实网页会遇到广告、导航、脚本、样式、评论区、推荐流、隐藏文本等噪声。

推荐依赖：

```bash
npm install @mozilla/readability jsdom
npm install -D @types/jsdom
```

可选：

```bash
npm install cheerio
```

依赖分工：

| 依赖 | 用途 |
|---|---|
| `jsdom` | 把 HTML 解析成 DOM |
| `@mozilla/readability` | 提取文章标题、作者、正文、摘要 |
| `cheerio` | 轻量读取 meta 标签、OpenGraph、清理节点 |

优先级：

1. `Readability` 提取正文
2. 如果失败，回退到清洗后的 `document.body.textContent`
3. 如果还是为空，返回 metadata-only 结果或失败

---

## URL 安全策略

`web_fetch` 最大风险是 SSRF。模型可以被诱导读取内网地址、云元数据地址、本机服务、文件协议等。必须先做安全门。

### 必须拒绝的 URL

协议层：

```text
file:
ftp:
data:
blob:
javascript:
mailto:
```

只允许：

```text
http:
https:
```

主机层必须拒绝：

```text
localhost
127.0.0.0/8
0.0.0.0
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
metadata.google.internal
```

云元数据地址必须拒绝：

```text
169.254.169.254
100.100.100.200
```

### 重定向也要重新校验

不能只校验初始 URL。攻击者可以提供公开 URL，然后 302 到内网地址。

建议：

- `redirect: "manual"` 手动处理重定向
- 最多允许 5 次重定向
- 每次跳转后的 URL 都重新跑 `validatePublicHttpUrl`
- 保留 `finalUrl`

### DNS Rebinding 防护

更完整的实现应该解析 hostname 到 IP，然后判断是否内网 IP。Node 内置 `dns.promises.lookup` 可以做。

流程：

```text
URL parse
  -> hostname
  -> dns.lookup(hostname, { all: true })
  -> 检查每个 address 是否 public
```

注意：fetch 真实连接时仍可能再次解析 DNS。严格防护需要自定义 agent 固定解析结果，但个人助手场景可以先做到“解析并拒绝明显内网地址”。

---

## HTTP Fetch 策略

### 请求头

```ts
const headers = {
  "User-Agent":
    "Mozilla/5.0 (compatible; PersonalAssistantBot/1.0; +https://local.app)",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};
```

### 超时

工具层已有 `runtime.timeoutSeconds`，但 fetch 内部仍建议用 `AbortController`：

```ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
```

原因：runtime 超时只能停止等待 Promise，不能保证底层请求及时释放资源。

### 响应大小限制

不能直接 `await response.text()` 读取无限大响应。

推荐上限：

```text
HTML 最大读取：2 MB
纯文本最大读取：1 MB
```

完美版应该使用 stream reader 逐块读取：

```ts
const reader = response.body?.getReader();
```

累计字节超过上限就停止，并标记：

```ts
bodyTruncatedByBytes: true
```

### Content-Type 白名单

允许：

```text
text/html
application/xhtml+xml
text/plain
application/json    // 可选，仅用于 API 文档或公开 JSON
```

拒绝：

```text
application/pdf      // 交给 pdf 工具
image/*
video/*
audio/*
application/zip
application/octet-stream
```

如果 content-type 缺失，可以读取前几个 KB 做轻量判断，但第一版可以保守拒绝或按 HTML 尝试。

---

## 正文提取策略

### 第一优先级：Readability

```ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const dom = new JSDOM(html, { url });
const reader = new Readability(dom.window.document);
const article = reader.parse();
```

可得到：

```ts
article?.title
article?.byline
article?.excerpt
article?.textContent
article?.length
```

### Metadata 提取

即使正文失败，也应该尽量拿到：

```text
title
description
og:title
og:description
article:published_time
author
site_name
canonical URL
```

优先级：

```text
og:title > twitter:title > <title>
og:description > twitter:description > meta[name=description]
article:published_time > time[datetime] > undefined
canonical href > finalUrl
```

### 回退方案：DOM Text

Readability 失败时：

1. 删除无关节点

```text
script
style
noscript
svg
canvas
iframe
nav
footer
header
form
aside
```

2. 读取：

```ts
document.body.textContent
```

3. normalize whitespace

```ts
text.replace(/\s+/g, " ").trim()
```

### 内容质量检查

正文太短时不要假装成功：

```text
少于 300 字符：可能不是正文页
少于 80 字符：应返回失败或 metadata-only
```

建议返回：

```ts
ok: false,
content: "网页读取成功，但未能提取到有效正文",
data: { metadata... }
```

---

## Evidence 压缩策略

`web_fetch` 的输出不应等于完整网页正文。它应该输出“可读正文摘录 + metadata + 截断说明”。

### 默认截断

建议：

```text
默认 maxChars：8000
最大 maxChars：20000
```

原因：

- runtime 还有 `truncateToolContent(toolResult.content, 2000)`，约 8000 字符
- 工具内部先压缩，避免 trace 和 UI 也被污染
- 深度研究需要更多内容时，可以显式加大 `maxChars`

### 头尾保留

普通 `slice(0, maxChars)` 会丢掉文章结论。更好的方式是头尾保留：

```text
前 70%：文章开头、背景、核心事实
后 30%：结论、限制、补充说明
```

格式：

```text
[文章开头部分]

...（中间内容已省略，原文共 N 字符）...

[文章结尾部分]
```

### 结构化摘要可作为第二阶段

第一版 `web_fetch` 不应该调用模型做总结，因为工具调用模型会带来成本、延迟和递归复杂度。

后续可以加 `web_extract_evidence` 或在 runtime 里做 evidence compaction：

```ts
type EvidenceDigest = {
  claims: Array<{
    text: string;
    quote?: string;
    sourceUrl: string;
  }>;
};
```

---

## Tool Definition 建议

```ts
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "读取一个公开网页 URL 的正文内容。适合在 web_search 找到候选结果后，对最相关网页进行精读。不要用于读取本地文件、内网地址、PDF 或非网页资源。",
  input_schema,
  riskLevel: "safe",
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 10,
    timeoutSeconds: 20,
    memoryLimitMb: 256,
    sandboxed: true,
    dangerous: false,
    costPerUse: 0,
  },
  execute,
};
```

工具描述里要明确“在搜索后精读”，这样模型更容易形成两阶段策略。

---

## 和现有 Runtime 的接入

当前 `runAgentLoop` 已经支持工具调用，不需要为 `web_fetch` 改 loop。

需要改：

```text
lib/agent/tools/builtin.ts
```

注册：

```ts
registry.register(webFetchTool);
```

建议改：

```text
lib/agent/prompt/segments.ts
```

在联网搜索策略里补充：

```text
当 web_search 返回候选结果后，只对最相关的 1-2 个 URL 调用 web_fetch 精读。不要批量抓取所有结果。回答时优先引用 web_fetch 的正文内容；如果只看到了搜索摘要，请说明依据有限。
```

可选改：

```text
lib/agent/runtime/index.ts
```

把 `web_fetch` 的来源也加入 `toolSources`：

```ts
if (toolUse.name === "web_fetch" && toolResult.ok && isWebFetchData(toolResult.data)) {
  toolSources.push({
    title: toolResult.data.title ?? toolResult.data.finalUrl,
    pageUrl: toolResult.data.finalUrl,
    excerpt: toolResult.data.excerpt,
  });
}
```

这样前端和 trace 可以显示网页来源，而不是只显示工具卡片。

---

## 错误处理设计

错误要对模型有帮助，不要只返回 `fetch failed`。

| 场景 | ok | content |
|---|---:|---|
| URL 为空 | false | `缺少 url 参数` |
| URL 协议不允许 | false | `web_fetch 只支持 http/https URL` |
| 内网地址 | false | `出于安全限制，不能读取内网或本机地址` |
| DNS 解析失败 | false | `无法解析该网页域名` |
| 超时 | false | `网页请求超时` |
| HTTP 403 | false | `网页拒绝访问，可能需要浏览器或登录` |
| HTTP 404 | false | `网页不存在或已被删除` |
| 非网页类型 | false | `该 URL 不是可读取的网页内容` |
| 正文为空 | false | `网页读取成功，但未能提取到有效正文` |

同时 `metadata` 里保留：

```ts
{
  status,
  contentType,
  finalUrl,
  reason,
}
```

---

## 测试方案

### 单元测试

重点测纯函数：

```text
parseInput
validatePublicHttpUrl
isPrivateIp
truncateMiddle
normalizeWhitespace
extractMetadata
formatResult
```

必须覆盖：

```text
拒绝 file://
拒绝 localhost
拒绝 127.0.0.1
拒绝 192.168.x.x
拒绝 169.254.169.254
允许 https://example.com
maxChars 超上限时被 clamp
正文过长时被头尾截断
Readability 失败时 fallback 到 body text
```

### 集成测试

不要依赖真实互联网，否则测试不稳定。建议用本地 mock server：

```text
GET /article       返回标准 HTML 文章
GET /redirect      302 到 /article
GET /private-hop   302 到 http://127.0.0.1
GET /large         返回超大 HTML
GET /pdf           返回 application/pdf
GET /empty         返回空正文 HTML
```

测试目标：

```text
能提取标题和正文
能跟随安全重定向
能阻止重定向到内网
能限制响应大小
能拒绝非网页 content-type
```

### Agent Eval

增加一个 eval case：

```text
用户：打开这个链接，总结主要观点：https://example.com/article
期望：调用 web_fetch
```

另一个：

```text
用户：搜索 OpenAI 最新模型并总结官方说明
期望：先 web_search，再对官方 URL 调 web_fetch
```

---

## 实现里程碑

### Phase 1：最小可用版

目标：能读取公开 HTML 并返回清洗正文。

范围：

- 新增 `web-fetch.ts`
- URL 协议校验
- 基础内网地址拒绝
- fetch + content-type 检查
- 简单 HTML 清洗
- `builtin.ts` 注册

适合快速验证 agent 两阶段检索。

### Phase 2：生产可用版

目标：稳定处理真实网页。

范围：

- 引入 `jsdom` + `@mozilla/readability`
- metadata 提取
- 手动重定向校验
- 响应体大小限制
- `AbortController`
- 单元测试

这是推荐落地版本。

### Phase 3：研究增强版

目标：让网页内容变成高质量 evidence。

范围：

- domain quality scoring
- 内容去重
- claim/quote evidence digest
- source metadata 进入 `toolSources`
- web_search 与 web_fetch 共享 source cache
- trace 中展示 fetch 的 title、finalUrl、originalChars、truncated

---

## 完整伪代码

```ts
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "读取一个公开网页 URL 的正文内容。适合在 web_search 找到候选结果后，对最相关网页进行精读。",
  input_schema,
  riskLevel: "safe",
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 10,
    timeoutSeconds: 20,
    memoryLimitMb: 256,
  },
  execute: async (input) => {
    const parsed = parseInput(input);
    if (!parsed.url) {
      return fail("缺少 url 参数", "Missing url");
    }

    const urlCheck = await validatePublicHttpUrl(parsed.url);
    if (!urlCheck.ok) {
      return fail(urlCheck.message, urlCheck.error);
    }

    try {
      const fetched = await fetchPageWithLimits(parsed.url, {
        timeoutMs: 18_000,
        maxBytes: 2 * 1024 * 1024,
        maxRedirects: 5,
      });

      const extracted =
        fetched.contentType.includes("text/plain")
          ? extractPlainText(fetched.body)
          : extractHtmlContent(fetched.body, fetched.finalUrl);

      if (extracted.text.length < 80) {
        return {
          ok: false,
          content: "网页读取成功，但未能提取到有效正文",
          error: "No readable content",
          data: {
            ...extracted.metadata,
            url: parsed.url,
            finalUrl: fetched.finalUrl,
          },
        };
      }

      const compact = truncateMiddle(
        extracted.text,
        clampMaxChars(parsed.maxChars),
      );

      return {
        ok: true,
        content: formatForModel({
          url: parsed.url,
          finalUrl: fetched.finalUrl,
          title: extracted.title,
          byline: extracted.byline,
          publishedAt: extracted.publishedAt,
          text: compact.text,
          truncated: compact.truncated,
          originalChars: extracted.text.length,
        }),
        data: {
          url: parsed.url,
          finalUrl: fetched.finalUrl,
          title: extracted.title,
          byline: extracted.byline,
          siteName: extracted.siteName,
          publishedAt: extracted.publishedAt,
          description: extracted.description,
          contentType: fetched.contentType,
          status: fetched.status,
          text: compact.text,
          excerpt: extracted.excerpt,
          originalChars: extracted.text.length,
          returnedChars: compact.text.length,
          truncated: compact.truncated,
        },
        metadata: {
          url: parsed.url,
          finalUrl: fetched.finalUrl,
          title: extracted.title,
          contentType: fetched.contentType,
          originalChars: extracted.text.length,
          returnedChars: compact.text.length,
          truncated: compact.truncated,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: "网页读取失败",
        error: error instanceof Error ? error.message : "Web fetch failed",
      };
    }
  },
};
```

---

## 与 web_search 的协同策略

`web_search` 返回应该尽量紧凑：

```text
标题
URL
摘要
发布时间
来源域名
相关度
```

`web_fetch` 只读取模型明确选择的 URL。系统 prompt 应限制：

```text
除非用户要求深度研究，否则每轮最多精读 1-2 个网页。
```

这样可以避免：

- 搜索返回 5 条
- 模型对 5 条全部 fetch
- 每条 8000 字
- 上下文瞬间爆炸

---

## 最终推荐方案

如果要“完美但不过度工程化”，建议直接做 Phase 2：

1. `web_fetch` 单独工具文件
2. `jsdom` + `@mozilla/readability` 提取正文
3. URL 安全校验，包括协议、localhost、私网 IP、云 metadata 地址
4. 手动重定向，每次跳转重新校验
5. 响应体大小限制，避免大文件撑爆内存
6. content-type 白名单，只处理网页和纯文本
7. 工具内部 `maxChars` 头尾截断
8. `data` 返回结构化 metadata
9. runtime 把 `web_fetch` 结果加入 `toolSources`
10. prompt 明确两阶段策略：先搜，再精读少数 URL

这个设计能覆盖个人助手的主要真实场景，也保留了继续演进到研究型 Agent 的空间。
