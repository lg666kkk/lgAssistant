# 图文混合文档 RAG 技术方案

状态：设计稿，2026-10-02。以当前工作区文件上传、检索与 Agent Runtime 实现为基础；本文不代表已实现能力。

## 1. 目标与边界

目标：图片中的内容可被检索；命中后能按需查看原图或 PDF 页面；答案能引用实际查看过的视觉证据。

采用“文本混合检索 + 视觉代理文本 + 按需视觉核实”，暂不引入多模态向量数据库，也不默认把整份文档放进模型上下文。

首版优先 PDF、DOCX。Markdown/HTML 中的内嵌 data URI 可以受限导入；相对路径图片标记为不可用，远程图片默认不抓取。Notion 图片与其他来源作为后续适配器，不能假设短期图片 URL 永久有效。

三个能力层级应分别展示：

- 文本已索引。
- 原图/页面可读取。
- 视觉内容已索引，可通过图中文字和描述召回。

只完成前两项，不应宣称图片内容已能被检索。

## 2. 当前代码基线

| 当前位置 | 已有能力 | 本方案变化 |
| --- | --- | --- |
| `lib/knowledge/file-parsers.ts` | PDF 按页提取文字，DOCX 转 HTML/Markdown | 输出页面清单、图片出现位置与提取结果 |
| `lib/knowledge/content-cleanup.ts` | 清理图片为占位符，规范化正文与链接 offset | 保留稳定 asset 引用与最终文本中的位置 |
| `lib/knowledge/files.ts` | 私有原文件存储、上传去重、同步、删除 | 调度视觉解析、创建资源 generation、清理派生对象 |
| `lib/knowledge/sync.ts` | SourceDocument、切块、Embedding、原子发布 | 支持额外视觉检索单元及 pipeline 版本 |
| `lib/knowledge/ingestion-queue.ts` | 重试、租约、文件任务 | 为视觉增强增加独立任务与过期发布保护 |
| `lib/knowledge/retriever.ts` | 关键词/向量混合召回、重排、MMR | 识别视觉代理记录，补齐关联上下文与资源信息 |
| `lib/agent/tools/search-notes.ts` | 检索、证据分级、上下文裁剪 | 在模型可见文本中明确返回资源与页码，不只放 data |
| `lib/agent/tools/types.ts` | ToolResult.content 为 string | 增加服务端解析的媒体引用 |
| `lib/agent/runtime/index.ts` | 工具结果文本裁剪、证据收集 | 加入安全媒体加载、视觉预算、证据绑定 |
| `lib/agent/runtime/model-provider.ts` | 用户消息图片可转发；工具结果被转为文本 | 实现逐 provider 的视觉工具结果传输 |
| `lib/agent/rag/evidence.ts`、`types.ts` | 文字证据、引用与 documentVersion | 增加视觉出处、观察记录与核实状态 |

注意：当前 evidence 的 documentVersion 可来自 chunk 的 content_hash，并不是可靠的文件版本。新增视觉链路必须显式携带 source_version，不借用 chunk 文本 hash。

## 3. 总体架构

```text
原文件 -> 私有 Storage
          |
          v
解析 worker -> 规范化正文 + 页面/图片清单
          |                     |
          v                     v
现有文本索引              原图保存 / PDF 页面渲染
          |                     |
          |                 OCR + 视觉描述
          |                     |
          +------ documents 检索索引 ------+
                                         |
用户问题 -> search_notes -> 混合召回 + 重排 + 小证据包
                                         |
                              是否需要核实视觉细节？
                                  /             \
                                 否              是
                                 |               |
                                 |       read_knowledge_visual
                                 |               |
                                 |       原图/页面 + 观察记录
                                 +-------+-------+
                                         |
                              引用检查 -> 答案 + 原文位置
```

资源存储和检索索引分离：Storage 保存字节；资源表保存身份、版本、位置；documents 保存供检索的文字，不存 base64 或短期签名 URL。

## 4. 数据模型

### 4.1 文件处理 generation

建议新增 `knowledge_file_generations`，文件记录保存 `active_generation_id`。generation 表示一次完整可发布的索引构建，不等同于文件字节版本。

```text
id, user_id, file_id
source_version          原文件 sha256；未来文件替换仍使用内容 hash
pipeline_version        解析器、OCR、描述 prompt/model、分块策略的版本指纹
status                  preparing / ready / active / failed / superseded
text_status, visual_status
manifest_hash
created_at, published_at
```

视觉增强生成新的 generation，正文和视觉记录一起发布，失败时继续使用旧 generation。所有文本与视觉 chunk 在新 generation 中明确标注来源，不能把独立插入视觉 chunk 的操作绕过原子发布。

### 4.2 视觉资源

新增 `knowledge_visual_assets`：

```text
id, user_id, file_id, generation_id, source_version
kind                    pdf_page / embedded_image / region（后续）
page_number             PDF 物理页码，1-based；DOCX 不伪造页码
occurrence_key          文档内出现位置；重复图片可以引用同一 blob
bbox                    可空，归一化 [x, y, width, height]
storage_path            可空，PDF 可以首次读取时生成
blob_sha256, mime_type, width, height, byte_size
caption, alt_text, heading_path
text_start, text_end    在最终规范化正文中的区间，可空
render_status           pending / ready / failed
analysis_status         pending / ready / partial / failed / skipped
ocr_text, description, analysis_model, analysis_version
warnings, created_at
```

约束：资源所属用户、文件与 generation 必须一致；按文件/generation 建索引；PDF 页面在同一 generation 内唯一。启用 RLS，并在服务端使用 service-role 时再次显式校验 user_id。

DOCX 一张图片出现多次时，“图片字节对象”和“图片出现位置”是两个概念：可以字节去重，但不合并上下文、图注和定位。

### 4.3 复用 documents 存视觉代理记录

保留 `source_type: document`，通过新字段区分，不新增 sourceTypes 枚举：

```json
{
  "source_type": "document",
  "content_kind": "visual_proxy",
  "file_id": "...",
  "generation_id": "...",
  "source_version": "file-sha256",
  "asset_id": "...",
  "page_start": 12,
  "page_end": 12,
  "analysis_version": "..."
}
```

代理文本格式：章节/标题、图注、可读文字、图类型、主要实体、关系/趋势、不确定部分。长 OCR 内容按现有 token 限制切块，每个子 chunk 均关联同一 asset；parent_key 应区分正文与视觉单元，防止上下文去重时吞掉其中一类。

正文 chunk 的 `metadata.visual_refs` 保存关联资源 ID；PDF 首版按页关联，不声称定位到了具体图。不把全部图片描述重复拼进每个正文 chunk。

## 5. 入库流程

### 5.1 PDF：页面优先

PDF 图表可能由文字、矢量线条和多张位图组成，提取嵌入图片不能代表页面。首版以整页渲染为视觉资源，不依赖精确图片检测。

1. 用现有 unpdf 提取逐页文字，记录所有物理页面，包括空文本页。
2. 生成页面资源清单；正文 chunk 按页关联资源。
3. 独立 worker 使用 PDFium/Poppler 一类渲染器生成页面图片；建议生产环境先用 Poppler 渲染方案做样本验证，再固定容器版本。不要让 Next.js 请求进程承担重型渲染。
4. 对低文字量页面进行 OCR；对图表、流程图、截图页面生成描述。只按“存在位图”筛选会漏掉矢量图，应使用布局/绘图信号或低清视觉分类。
5. 小文档可在用户开启视觉索引后全页分析；大文档先分类、再分析候选页。预算不足的页面显式标记 skipped，提供手动补索引入口。

空文本扫描页必须通过视觉代理进入索引，不能因为正文为空就丢弃。OCR 失败也要保留页资源及错误状态。

页面先建议按 144 DPI 渲染，单边限制约 2,000 像素；密集页面按需更高分辨率或分区。上述为压测初值，不是质量保证。

### 5.2 DOCX：提取原图，绑定出现位置

用 Mammoth 自定义 convertImage 回调受限读取图片字节，生成 asset 引用，再转换成带身份的占位符。保留 Word alt、图注和邻近正文。不依赖 `<img src>` 把 base64 穿过整个 Markdown 清理链路。

建议内部使用结构化图片节点或临时标记映射，最终输出可读的 `【图片：说明】`；资源 ID 写 metadata。资源偏移在最终规范化文本上计算，不能使用原始 HTML offset。

Mammoth 对浮动对象、SmartArt、绘图等的完整保真不能先验保证；检测到不支持对象时提示部分解析。DOCX 精确页码需要单独的排版渲染能力，不纳入首版。

### 5.3 Markdown / HTML

data URI 受字节与像素限额导入；远程 URL 只记录不可用引用，默认不发起网络请求；相对路径不解释成服务器路径。以后启用远程抓取需防 SSRF、逐跳检查重定向/DNS、限流与超时，不直接复用任意 URL 下载。

### 5.4 OCR 和视觉描述

OCR 使用独立 provider 接口，先验证中文、小字号、图例与表格样本后选定引擎；视觉描述使用用户明确配置的视觉模型。缺少模型/授权时跳过描述，不偷偷切换到平台付费模型。

结构化输出建议包含 `figure_type`、`visible_text`、`entities`、`relationships`、`trends`、`uncertainties`。要求不补造数值、不把视觉推断写成原文；保留 OCR 与模型描述的 provenance。模型给出的 confidence 只作诊断，不作为真实性阈值。

图表精确读数在问答阶段核实，入库描述主要用于召回。描述缓存按用户范围内的 blob hash、相关上下文 hash、模型与分析版本隔离。

## 6. 发布、重试与删除一致性

沿用现有文件发布/删除共用事务锁的原则，新增 generation 发布 RPC：在同一事务中校验文件存在、source_version、预期 active generation 和 worker 租约/任务 token，再替换完整索引、切换 active_generation_id。迟到 worker 不能覆盖已发布的新 generation。

Storage 不参与数据库事务：先写 staging 对象和 manifest，再事务发布引用。事务失败的对象由周期 GC 清理；未 ready 的资源不向模型开放。

文本先可用、视觉后增强：初次可以发布 text-only generation；后续增强完成后发布含文本和视觉的完整 generation。视觉失败不使已可用正文失效，用户看到 visual_status=partial。

文件删除事务取消文本/视觉任务、撤销当前 generation、删除检索记录，并写入持久清理任务；提交后删除原文件和派生对象，失败可重试。任务中检查已删除文件，清理自己的 staging 对象，禁止重新发布。

并发问答遇到 generation 切换应返回 stale_reference 并重新检索，或使用受限短期 snapshot；首版建议前者，不允许拿旧描述读取新图片。

版本判断除现有 content_hash、embedding_model、chunker_version 外，还应检查 pipeline_version 和 manifest_hash。源字节不变但视觉 prompt/模型升级时，也必须能够重建索引并使检索缓存失效。

## 7. 检索与小证据包

继续使用现有向量+关键词召回、RRF、重排与 MMR。正文和视觉代理共享候选池，重排时加入标题、图注、正文语境，不仅使用泛化描述。

命中后按 file/version/asset 去重，并补齐必要的关联正文。图片清单必须进入 search_notes 的模型可见 content，而不仅保留在程序侧 data。

```text
[ev_xxx] 文件名 / 第 12 页
证据类型：视觉索引代理，尚未针对当前问题核实
相关内容：支付服务调用订单服务与风控服务……
可读取资源：asset_xxx
读取条件：核实箭头方向、组件关系或图中数值时读取原页
```

同时返回结构化 visual_refs，并在 request-scoped registry 记录可读资源、用户、source_version、generation。该 registry 不接受模型自行填写的路径或权限信息。

视觉代理不能仅因已有描述而直接被判为强视觉证据。位置已命中但视觉核实尚未完成时，不应被文本 Evidence Grader 提前判定“无可用证据”而阻断读取。

## 8. 原图读取工具与模型传输

新增 `read_knowledge_visual`，能力建议为 `private.knowledge.visual.read`，输入只接受检索返回的 asset ID：

```ts
type ReadKnowledgeVisualInput = {
  assetIds: string[];
  question: string;
};
```

服务端执行：鉴权、检查资源是否在本次授权证据包内、校验版本/状态、读取私有对象或受限渲染页面、必要时执行针对问题的视觉观察。工具风险为 safe/read，但有模型费用和运行预算，不代表零成本。

支持两种路径：

- 当前模型支持视觉：返回媒体引用和文本定位，Runtime 加载字节，模型看原图。
- 当前模型不支持视觉：用户已配置视觉分析模型时，工具调用分析模型并返回观察记录；没有配置时明确说明不能核实图片，仍可保守引用文本/OCR。

`supportsImageInput` 只能说明图片输入能力，不代表工具结果图片可传输。新增 provider 级能力，例如支持结构化视觉 tool_result，或者必须使用工具收据后关联 user 图片消息。

ToolResult 向后兼容扩展 `mediaRefs`，内部保存受信 asset ID、mime、出处，不保存任意 URL。Anthropic 路径可用结构化工具内容；OpenAI-compatible 路径按实际支持情况使用 SDK 多模态工具输出，或完成 tool 消息后追加明确绑定 tool_call_id/evidenceId 的 user 图片消息。不能让现有 stringifyToolResultContent 把图片 JSON 转成文本。

请求级二进制加载器在最后一步构造真实图片块。文本裁剪只裁文字；图片预算、字节限额与 token 估算单独处理。不要把 base64 写进 trace、SSE、工具 artifact 或数据库消息 JSON；持久化的是可重新鉴权加载的媒体引用。

视觉调用条件：问题涉及图表/流程/关系/精确读数，或文本不足以作答。含图片占位符只是信号，不强制读取所有关联图片。用结构化规划与模型判断，不只依赖关键词。

## 9. 视觉证据与答案校验

扩展 EvidenceCitation：`fileId`、`sourceVersion`、`generationId`、`pageNumber`、`assetId`、可选 bbox。图像有明确身份，视觉代理、原始 OCR、问答观察记录分别标记 evidence kind。

视觉观察记录包括：问题、原图出处、观察结果、可读标签、近似值/单位、不可读部分、模型与观察版本；工具按现有 cited_evidence policy 返回 EvidenceBundle，Runtime 合并到本轮证据集合。

当前文字词面支持校验不能验证“箭头从 A 指向 B”这类视觉事实，也可能误拒绝正确视觉答案。不能直接关闭所有 grounding：保留引用存在性、实际可见证据、版本绑定检查；视觉事实先与观察记录对照，重要读数可由视觉模型复核，证据不足时输出不确定性。模型复核仍非事实真值证明。

原图仅加载成功不等于事实核实成功：区分 loaded 与 observed 状态，不把资源 ID 的存在当作答案准确的证明。引用 UI 展示“文件名 · PDF 第 N 页 · 图/页面”，点击经过同源鉴权打开原文；扫描页码与印刷页码不混淆。

## 10. 安全与预算

所有文档、OCR、图片描述和视觉内容都是不可信材料，禁止把图中指令提升为系统/工具调用指令。

保留现有 20MB 文件、200 页 PDF、DOCX 解压限额；新增图片像素、解码内存、累计派生大小与渲染超时限制。SVG/EMF/WMF 等格式不直接给模型或前端执行，隔离转换后使用 PNG/JPEG；失败则标记不支持。

建议初值：每次工具最多 3 个资源；每轮最多 2 次视觉读取且总计不超过 6 张；单图不超过现有聊天图片 5MiB 限制。文件视觉增强单独设置页数、费用和用户并发预算。具体超时根据 worker 渲染与模型耗时压测配置，不沿用所有轻量工具的 30 秒默认值。

签名 URL 不入索引、不进日志；模型输入的内容会发送给对应模型提供方，配置中应明确展示处理方和费用。日志只记资源 ID/hash、尺寸、状态、耗时、tokens、成本和错误码。

缓存按用户、版本、权限、问题、模型、分析版本隔离；删除后撤销应用访问。已签发 URL 在过期前可能仍有效，需要短 TTL 或代理读取，不承诺即时撤销所有 URL。

## 11. 分阶段落地与验收

### 阶段 A：可定位、可读取

新增资源清单和私有派生存储；PDF 页面按需渲染、DOCX 原图落存；search_notes 返回 visual_refs；新增读取工具、provider 传输适配、视觉出处引用。

此阶段只能保证“文本命中后看图”，不能保证纯视觉信息的召回。验收必须检查真实请求 payload 含图片内容，而不是只检查 ToolResult 有 URL。

### 阶段 B：图片内容可召回，完成首版闭环

新增 OCR/描述队列、visual_proxy chunks、完整 generation 发布与缓存失效、非视觉主模型的分析模型兜底、视觉观察证据与 grounding 适配。

使用仅出现在图片中的实体、数字、关系进行测试：必须无需命中邻近正文即可找到对应页面。扫描 PDF、纯矢量流程图属于必测样本。

### 阶段 C：成本与精度优化

增加区域检测、按需高清裁剪、远程图片安全导入、Notion 图片适配。是否引入多模态 embedding 由真实召回缺口决定，不作为默认前置工作。

### 测试清单

- 单元：图片位置映射、重复图片不同上下文、空页物理页码、代理分块、媒体裁剪和预算。
- 集成：删除与发布竞态、过期租约、重复增强、索引切换、对象上传失败、孤儿清理、跨用户资源读取拒绝。
- Provider：Anthropic/OpenAI-compatible 真正传图、工具 ID 配对、非视觉降级、压缩后媒体引用重新加载、日志无 base64。
- 安全：图内提示注入、SSRF 输入、图片/ZIP 解码炸弹、过期引用、猜测 asset ID。
- 端到端：只有图片包含答案、图文互补、密集图表、低分辨率截图、图片不可读、预算耗尽、没有视觉模型。

建议建立至少 40 个标注问题，分别覆盖文本、OCR、视觉关系和精确读数。比较纯文本 RAG、视觉代理 RAG、代理+原图核实三组，记录 Recall@K、视觉问题正确率、出处正确率、拒答校准、P95 延迟和单问成本。质量上线阈值依据这套基线制定；跨用户读取和版本串用必须零通过。

## 12. 推荐实施决策

1. 不更换现有检索栈；视觉代理复用 documents、混合检索与重排。
2. PDF 首版做页面级视觉资源，不先做精确图片提取。
3. 阶段 A 和 B 一起定义为完整能力；单纯存图片是基础设施，不是完整多模态 RAG。
4. 先验证工具结果跨 provider 传图与视觉 grounding，再批量开启入库描述，避免花钱建索引但问答链路无法使用。
5. 所有新写入坚持 generation 原子发布与删除一致性，不在现有发布后零散追加视觉 chunk。
