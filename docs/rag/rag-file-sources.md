# RAG 自定义文件数据源

状态：已实现 MVP（2026-10-02）。需要先执行迁移 `docs/schemas/migrations/20261002-rag-file-sources.sql`。若已执行旧版本，也需重新执行更新后的迁移（可重复运行），以安装原子删除 RPC 和索引发布时的文件存在性检查。

用户在「知识库 → 数据源」上传 PDF / Markdown / TXT / HTML / DOCX，后台解析为 Markdown 后，复用 Notion 的切块、Embedding、原子写入与检索链路。回答引用可点开原文件，PDF chunk 带页码。

## 1. 核心概念

### 1.1 「读取层」与「索引层」分离

RAG 入库可以拆成两段：

| 阶段 | 和来源有关吗 | 做什么 |
|---|---|---|
| 读取（loader / parser） | 有关 | 把 Notion 块树、PDF、DOCX 等变成纯文本或 Markdown |
| 索引（indexer） | 无关 | 版本判断 → 切块 → Embedding → 原子替换 chunks |

原来 `syncNotionPageOnce` 把两段写在一起。这次把后半段抽成 `indexSourceDocument(SourceDocument)`，Notion 和文件各自只负责产出一个 `SourceDocument`。以后要加网页、飞书等来源，也只需写读取层。

### 1.2 统一转成 Markdown

`chunkText` 按 Markdown 结构切块：先按标题层级分 section，再保证代码块和表格不被切断，最后按 token 拆分。所以解析器的目标不是“提取文字”，而是“提取带结构的文字”：

- HTML 和 DOCX 先变成 HTML，再用 turndown 转成 Markdown。标题会变成 `#`，列表、加粗、代码块也会保留。
- PDF 本身没有可靠的结构信息，只能按页提取文本。页码通过偏移量映射补回来（见 1.4）。

### 1.3 内容寻址与幂等

- **上传去重**：对文件字节算 sha256，再加 `UNIQUE(user_id, sha256)` 约束。重复上传会返回已有记录（`duplicate: true`），不会产生第二份索引。
- **重复入库跳过**：`indexSourceDocument` 沿用 `content_hash + embedding_model + chunker_version` 的版本判断，没变化就 `skipped`。只有用户点“重新入库”时才传 `force`。
- **并发上传**：两个请求同时上传同一个文件时，后插入的那个会撞唯一约束（`23505`）。此时删掉自己刚上传的 Storage 对象，返回先写入的那条记录。

### 1.4 PDF 页码：字符偏移映射

每个 chunk 都有 `startChar/endChar`，即它在 `chunkText` 输入文本中的偏移。解析 PDF 时同时记录每页起始偏移 `pageOffsets`。对 chunk 区间做二分或线性查找，就能得到 `page_start/page_end`，写进 chunk metadata。

前提是 **chunkText 不能改动偏移**。`chunkText` 内部会 `trim()`，还会把 `\n{3,}` 折叠成 `\n\n`。所以拼接 PDF 页面时：

- 页与页之间固定用 `\n\n`；
- 空页（扫描页）不追加分隔符，只记录一个与下一页相同的偏移；
- 每页文本先自行 trim，并把内部的 `\n{3,}` 折叠掉。

这样 content 本身就是 chunkText 规范化后的“不动点”，偏移不会错位。单测 `file-parsers.test.ts` 用手写的三页 PDF（中间一页为空）验证了这一点。

## 2. 关键代码走读

```
上传 POST /api/knowledge/files (multipart)
  └─ uploadKnowledgeFile          lib/knowledge/files.ts
       ├─ detectKnowledgeFileKind 扩展名白名单 + 魔数校验
       ├─ sha256 去重
       ├─ Storage: knowledge-files/<user>/<fileId>/source.<ext>
       └─ insert knowledge_files
  └─ enqueueRagIngestionJob(page_id = file:<fileId>, tree = false) → 202

worker（cron / scripts/rag-ingestion-worker.ts）
  └─ processJob                   lib/knowledge/ingestion-queue.ts
       └─ parseFilePageId ? syncKnowledgeFile : syncNotionPage(s/Tree)
            ├─ 下载 Storage 对象
            ├─ parseKnowledgeFile → { title, content, pageOffsets }
            └─ indexSourceDocument({ sourceType: 'document', chunkMetadata: 页码 })
                 └─ RPC sync_notion_page_documents_atomic（source_type 走 p_page_metadata）
```

### 2.1 `SourceDocument`（lib/knowledge/sync.ts）

```ts
export type SourceDocument = {
  sourceType: KnowledgeSourceType;   // 'notion' | 'document'
  pageId: string; title: string; url: string; content: string; lastEditedTime: string;
  pageMetadata?: Record<string, unknown>;                       // 写入 notion_pages.metadata
  chunkMetadata?: (chunk: TextChunk) => Record<string, unknown> | undefined; // 每个 chunk 追加
};
```

在 `buildAtomicDocumentPayload` 里，`chunkMetadata` 的结果**先展开**，核心字段（`page_id`、`source_type`、`embedding_model` 等）后写。这样来源适配器无法覆盖核心字段，有单测覆盖。

### 2.2 文件解析（lib/knowledge/file-parsers.ts）

- `detectKnowledgeFileKind`：扩展名决定类型，再用文件头校验。PDF 文件头是 `%PDF`；DOCX 是 zip，文件头为 `PK\x03\x04`；文本类文件前 8KB 不能出现 NUL。这样可以挡住改了扩展名的二进制文件。
- `parseKnowledgeFile`：md 和 txt 直接解码（去 BOM、统一换行）；html 用 turndown；pdf 用 unpdf 按页提取；docx 先用 mammoth 转 HTML，再用 turndown 转 Markdown。专用 table 规则保留表头、行列、空单元格及单元格内格式；没有表头的 DOCX 表格补空表头，正文行不会被吞掉。PDF proxy 在 `finally` 中调用 `loadingTask.destroy()`，成功和提取失败均释放资源。
- 解析器都通过 `await import()` 懒加载，只在 worker 真正处理到对应类型时才加载 pdf.js 等重依赖。

### 2.3 删除与竞态（lib/knowledge/files.ts）

`deleteKnowledgeFile` 调用 `delete_knowledge_file_atomic`，在一个事务内取消未完成任务（含 running）、删除索引和文件元数据，再于事务提交后清理 Storage 对象。清空知识库也逐文件调用同一 RPC。

删除 RPC 与索引发布 RPC 按 `user_id:page_id` 获取同一把 advisory transaction lock。发布时在锁内检查文件是否存在：若发布先提交，删除事务会清除索引；若删除先提交，迟到的发布会失败，worker 确认文件已不存在后返回 `skipped`。这样不会出现“检查时仍存在，随后删除元数据，但索引已重新写回”的竞态。

### 2.4 引用链接

索引里的 `page_url` 是 `/api/knowledge/files/<id>`，而不是 Storage 签名 URL：签名 URL 会过期，写进索引就失效了。访问时 GET 路由用 cookie 鉴权，校验文件属于当前用户，再 302 跳转到 10 分钟有效的签名 URL。

### 2.5 检索侧

- 检索过滤 `filters.sourceTypes` 原本就有 `"document"` 取值，SQL 中的 `rag_document_matches_filters` 读的是 chunk 的 `metadata->>'source_type'`。文件 chunk 写入 `source_type: 'document'` 后，不用改 SQL 就能被过滤和检索。
- `retrieval-router` 有两处调整：
  - “我上传的文件 / 上传的 PDF 里”这类说法会进入 knowledge 路由；
  - 泛指“笔记/文档/资料”时，过滤条件是 `[notion, document]`，不再只有 `notion`。

### 2.6 资源限额

- 单个原文件最多 20MB；multipart 请求体（含所有字段与边界）最多 21MB。
- 请求体在读取流时累计字节数，超限立即终止并取消上游。`Content-Length` 仅用于提前拒绝，缺失或虚报不能绕过流式限制。超过单文件上限也在 `arrayBuffer()` 前拒绝。
- PDF 最多 200 页，在文档加载后、提取正文前检查；超限时仍释放 PDF 资源。
- DOCX 最多 2,000 个 ZIP 条目，单条目解压后最多 16MB（`word/media/*` 图片只受总量约束），总解压量最多 64MB。在调用 Mammoth 前使用 yauzl 逐条流式解压校验，丢弃验证内容，不累积解压缓冲区。目录声明的大小与实际输出均受检查，伪造小尺寸、加密条目和不支持的压缩格式会被拒绝。
- 现有解析后 2,000,000 字符上限继续保留。这些限额不替代未来的解析超时、进程内存和用户并发限制。

### 2.7 图片与链接清理（lib/knowledge/content-cleanup.ts）

**问题**：Mammoth 默认使用 `images.dataUri`，会把图片转成 `data:image/png;base64,...` 写进 HTML，再经 Turndown 变成 `![](data:...)`。HTML/Markdown 中的 data URI 也有同样问题。这些 base64 内容会进入切块和 Embedding：既污染向量，也容易撞上 200 万字符上限。链接 URL 是另一种噪声，而且 `javascript:` 链接可能在前端展示时被执行。

**做法**（第一档，只做占位，不存图片）：

| 输入 | 处理 |
|---|---|
| DOCX 图片 | `convertImage: mammoth.images.imgElement(async () => ({ src: '' }))`，不读取图片字节，Mammoth 自动带上 Word 里的替代文字 |
| HTML/DOCX `<img>` | Turndown 规则 `knowledgeImage` → `【图片：alt】`，无 alt 时为 `【图片】` |
| Markdown `![alt](src)` | `cleanKnowledgeMarkdown` 用正则替换成同样的占位符 |
| `[文字](url)` | 正文只保留文字；`http/https/mailto` 链接记录到 `links`，其他一律丢弃 URL（`javascript:`、`data:`、`file:`、相对路径、`#锚点`） |
| 代码块 / 行内代码 | 原样保留，不做替换 |
| 纯文本 / PDF | 不处理（没有 Markdown 语义，PDF 还要保持 `pageOffsets` 对齐） |

URL 校验直接用 `new URL(value)`：不传 base 时，相对路径和锚点会抛错，正好丢弃；协议走白名单，大小写混写的 `JaVaScRiPt:` 也会被 URL 规范化后拦下。

**链接进 chunk metadata**：`cleanKnowledgeMarkdown` 返回 `links: [{ text, url, offset }]`，`offset` 是链接文字在**最终 content** 中的位置。`syncKnowledgeFile` 的 `chunkMetadata` 用 `linksInSpan(links, startChar, endChar)` 取出落在 chunk 区间内的链接，去重后最多保留 20 个，写入 `metadata.links`。正文不含 URL，引用时仍能拿到原链接。

**关键不变量**：清理结果先经过 `normalizeKnowledgeContent`（与 chunkText 相同的 `trim + \n{3,}→\n\n`）。这样 content 是 chunkText 预处理的不动点，`chunk.startChar` 与 `links.offset` 在同一坐标系里，和 PDF 页码偏移用的是同一个思路（见 1.4）。

**占位符为什么用全角括号**：`[图片: x]` 后面如果紧跟 `(...)`，会被当成 Markdown 链接再解析一遍；`【图片：x】` 不会与 Markdown 语法冲突，中文语料中也比较自然。

## 3. 技术决策

| 决策 | 选择 | 放弃的方案 | 理由 |
|---|---|---|---|
| 来源表 | `notion_pages` 加 `source_type` | 改名为 `knowledge_sources` | 改名会牵动检索 RPC、外键、快照和所有查询，风险高；加一列即可复用 documents 级联、版本快照和队列 |
| source_type 取值 | `document` | `file` | 与已有的检索过滤词表 `RetrievalFilters.sourceTypes` 保持一致，否则过滤会把上传文件当成 notion |
| page_id | `file:<uuid>` | 单独的 source_id 列 | 队列、RPC、advisory lock 都以 page_id 为键，加前缀就能区分来源；生成列 `rag_ingestion_jobs.source_type` 方便观测 |
| 原子 RPC | 签名不变，source_type 放进 `p_page_metadata` | 新增参数 | 新增参数会产生函数重载，旧代码和新代码在迁移窗口内容易调错 |
| 入库方式 | 异步队列，接口返回 202 | 上传请求内同步解析 | PDF 解析和 Embedding 可能要几十秒；队列已有重试、租约和死信 |
| PDF 库 | unpdf（pdf.js serverless 版） | pdf-parse | pdf-parse 长期不维护，也拿不到逐页文本；unpdf 支持 `mergePages:false` |
| DOCX 库 | mammoth → HTML → turndown | 直接提取纯文本 | 能保留标题层级，切块效果更好 |
| 文档内图片 | 占位符 `【图片：alt】`，不保存图片本身 | 保留 base64 / 立即接视觉模型 | base64 会污染 Embedding 并挤占字符上限；视觉描述成本高，作为后续档位 |
| 链接 | 正文留文字，安全 URL 进 chunk metadata | 正文保留 Markdown 链接 | URL 对语义检索是噪声，非白名单协议有 XSS 风险；放在 metadata 里引用时仍可用 |
| Storage key | `source.<ext>`，原名存数据库 | 用原始文件名作 key | 中文、空格和特殊字符在 Storage key 里容易出问题，原名只用于展示 |

## 4. 踩坑记录

1. **`for...of` 遍历 Uint8Array 报 TS2802**：tsconfig 的 target 较低，没有开 downlevelIteration。改用 `bytes.subarray(0, 8192).includes(0)`。
2. **PDF 页码错位风险**：见 1.4。如果按“每页后面都加 `\n\n`”的直觉拼接，遇到空页就会产生 `\n\n\n\n`，被 chunkText 折叠后，后续所有页码都会偏移。
3. **source_type 词表不一致**：一开始写的是 `'file'`，后来检查检索代码才发现，过滤器和 `retriever.ts` 的内存过滤都只认 `notion | document | web`。其他值会被归为 `notion`，按 document 过滤时永远查不到。教训：新增枚举值前，先 grep 下游的消费方。
4. **路由把上传文件过滤掉**：原规则中“文档/资料”只会推入 `notion` 过滤，文件上线后，这类问题会悄悄漏掉上传内容。
5. **删除与入库的竞态**：见 2.3。删除接口删掉索引后，写后检查仍有时间窗口，因此删除与发布必须共用事务锁，发布在锁内验证文件存在性。
6. **Mammoth 默认内联 base64 图片**：Mammoth 的默认图片转换器是 `images.dataUri`，一张 2MB 截图会变成约 270 万字符，单张就超过文本上限。改为自定义 `convertImage` 后不再读取图片字节。
7. **Turndown 会转义方括号**：正文里的 `[` 会被写成 `\[`。链接正则必须用 `(?<!\\)` 跳过转义括号，否则会把普通文字当成链接剥掉。
8. **`String.prototype.matchAll` 在当前 target 下报 TS2802**：与第 1 条同因，改用 `Array.from(text.matchAll(...))`。
9. **放宽 `word/media/*` 单条目限制的方式**：不能直接 `continue` 跳过校验。ZIP 内的路径名可以随意取，攻击者可以把主文档 XML 放进 `word/media/`，再用 rels 指过去。因此 media 只免除 16MB 单条目限制，仍然流式解压，并计入 64MB 总量。

## 5. 后续可做

- 文件替换（新版本可用前保留旧版本）、启用/停用开关；
- 扫描版 PDF 走 OCR；表格类文件（xlsx、csv）；
- 解析超时及独立进程的内存限制；
- 解析任务的用户级并发限制；
- 引用卡片展示页码（metadata 中已有 `page_start/page_end`）和链接（`metadata.links`）；
- 图片第二档：图片存入 Storage，占位符编号为 `【图片 n】`，在 metadata 中记录 `image_refs`；
- 图片第三档：用用户的视觉模型（`supportsImageInput`）生成图片描述并入索引，回答时可附带原图。
