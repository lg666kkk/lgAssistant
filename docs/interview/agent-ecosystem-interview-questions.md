# Agent 生态与规模化面试题库（MCP、多智能体、工具规模化、沙箱）

> 以面试官视角整理，补齐其他专题题库未覆盖的四个 2025-2026 高频方向：工具生态标准（MCP）、工具规模化、多智能体编排、执行沙箱与长任务。
> 每题给出「想听」「项目落点」「追问」或「边界」。本项目在这四个方向大多处于“单 Agent + 自建工具系统”的合理停止点，因此这份题库的正确用法是：**讲清项目当前形态为什么够用，以及规模化后第一步怎么改**——而不是把没做过的东西说成已实现。
> 核心代码对照：`lib/agent/tools/registry.ts`、`lib/agent/tools/tool-router.ts`、`lib/agent/tools/types.ts`、`lib/agent/runtime/plan-execution.ts`、`lib/agent/tools/web-fetch.ts`、`lib/knowledge/ingestion-queue.ts`。

---

## 当前项目形态总结

回答本题库任何问题前，先明确项目现状，避免夸大：

- 工具系统是**自建 Registry + Router**：11 个内置工具、手写 JSON Schema、风险等级/确认/限流/超时/并发组策略；没有接入 MCP，也没有动态工具发现。
- Plan-and-Execute 是**单 Agent 的受控分步执行**：所有步骤共用同一 Runtime、模型、会话和工具注册表，没有独立 AgentDefinition、消息协议或并行 DAG，因此不是多智能体系统。
- `ToolRuntimePolicy` 中 `sandboxed`、`memoryLimitMb` 等字段是**声明而非 enforcement**：通用 Router 没有创建 OS/容器级隔离。
- 后台执行有两种可靠性级别：Scheduler 的 Redis ZSET 到期队列（非原子领取）和 RAG ingestion 的数据库 lease 队列（原子 claim + 退避 + dead 状态），后者更接近 durable worker。
- 长任务的连续性靠 ContextSnapshot 解决“上下文可恢复”，但没有 durable AgentRun/StepRun，进程重启后不能从中断步骤继续执行。

---

## 使用方式

每题先练 60-90 秒主回答。这一题库的推荐表达结构：

1. **解释这个技术解决什么老问题**：不能只报名词。
2. **对照项目当前实现**：自建方案覆盖了什么、没覆盖什么。
3. **给出引入条件**：什么规模/场景下值得引入，现在为什么不需要。
4. **说清安全边界**：生态化引入的每一步都在扩大信任面。
5. **给验证方法**：工具选择准确率、handoff 成功率、隔离测试、逃逸测试。

---

## 第一层：MCP 与工具生态

### Q1. MCP（Model Context Protocol）解决什么问题？和你项目自建的 Tool Registry 是什么关系？

- **想听**：MCP 是工具/资源/提示的开放接入标准，解决“每个 Agent 应用都要为每个外部系统写一遍适配”的 M×N 集成问题——工具提供方实现一次 MCP server，任何支持 MCP 的客户端都能用。它标准化的是**发现与传输**（工具列表、schema、调用、资源、鉴权握手），不替代应用侧的治理。
- **项目落点**：本项目 Registry 管定义与查找、Router 管风险/确认/限流/超时——这些治理职责在 MCP 语境下仍然属于客户端应用，MCP 只是把“工具从哪来”标准化了。可以回答：自建工具相当于 in-process tool，MCP server 相当于 out-of-process tool，两者可以并存挂到同一个 Registry 后面。
- **追问**：如果把 `search_notes` 暴露成 MCP server 会得到什么、失去什么？（得到：其他 MCP 客户端可复用、进程隔离；失去：进程内的 userId 注入和执行上下文需要改为显式鉴权传递，延迟增加。）

### Q2. 接入第三方 MCP server 后，哪些治理职责绝对不能外包给它？

- **想听**：权限与确认（riskLevel/审批）、租户隔离、限流配额、结果整形与截断、审计脱敏、成本核算。MCP server 自报的工具描述和 schema 都是**不可信输入**——描述可以撒谎，schema 可以过度索权。
- **项目落点**：当前 Router 的策略执行点在服务端调用前，这个模式恰好是正确答案：把 MCP 工具当成一种 `ToolDefinition` 的 execute 实现，风险策略仍由本地 `ToolRuntimePolicy` 声明并由 Router enforcement，未知的第三方工具默认按最高风险处理。
- **边界**：本项目尚未接 MCP，回答时说“我的 Router 架构天然支持这样接入”，不要说“已支持 MCP”。

### Q3. MCP 生态有哪些真实攻击面？

- **想听**：至少四类。①工具描述注入——描述本身携带指令诱导模型调用或改变行为（description 会进入上下文，是攻击面）；②rug pull——server 更新后同名工具语义或参数悄然改变；③工具结果注入——和 RAG Prompt Injection 同源，但工具结果往往被默认信任；④凭证代持——server 持有用户 OAuth token，server 被攻破即凭证泄漏。
- **想听（防线）**：工具描述纳入版本审计（hash 固定、变更需人工审核）、按工具而不是按 server 授权、结果标记为不可信数据、读过第三方工具结果后调用副作用工具需重新确认。
- **追问**：这和你项目 RAG 的 Prompt Injection 治理有什么共通结构？（都是“外部内容不能获得指令权限”，trust label 和二次确认策略可以复用。）

### Q4. 动态工具发现（运行时拉取工具列表）对上下文和路由意味着什么？

- **想听**：工具 schema 占输入 token，动态发现使工具集合不可预测——上下文预算、prompt cache 前缀稳定性和模型路由准确率都会被破坏。成熟做法是发现与暴露分离：发现到的工具进入本地目录，按任务/意图筛选一个小子集给模型，而不是把几百个工具 schema 全量塞进请求。
- **项目落点**：项目已有两层工具裁剪（RetrievalPlan 过滤检索工具、用户意图过滤 create_todo/ask_user），这正是“按需暴露”的雏形；ContextPlan 也已把 tool schema token 记为独立预算项。可以把动态发现描述为“把裁剪的输入集合从 11 个静态工具变成动态目录”，架构不需要推翻。

### Q5. Agent 代表用户调用外部服务时，凭证应该怎么管理？

- **想听**：模型永远不能见到凭证——凭证注入发生在工具执行层，不在 prompt 层；按用户+服务隔离存储、加密、可撤销；最小 scope 授权；凭证使用写审计。OAuth 场景下 Agent 应用是 confidential client，token 存服务端。
- **项目落点**：项目运行时配置已有 AES-256-GCM 加密 + 白名单注册表 + 管理员审计，是同一模式的单租户版本；工具执行上下文由 Router 注入 userId 而不是让模型传参，这就是“身份不走 prompt”的实例。
- **追问**：为什么工具参数里不能有 `userId` 字段让模型填？（模型可被诱导填别人的 ID；租户身份必须来自认证上下文，模型参数只表达业务意图。）

---

## 第二层：工具规模化

### Q6. 工具从 11 个涨到 100+ 个，系统里什么最先坏？

- **想听**：按顺序——①上下文：全量 schema 超出预算、稀释注意力；②路由：模型误选率随选项数上升，相似工具互相干扰；③治理：每个工具的风险策略、限流、审计配置维护成本线性增长；④评测：工具选择准确率没有分层数据集就无法回归。
- **项目落点**：项目当前把全部（裁剪后的）工具 schema 交给模型，11 个规模下成立；ContextPlan 已记录 tool schema token，这是发现“工具预算失控”的观测钩子。

### Q7. 工具太多时如何做“检索式工具选择”（tool retrieval）？

- **想听**：把工具描述当文档做索引（embedding/关键词），按当前任务检索 top-k 工具再暴露给模型——本质是对工具目录做 RAG。关键设计点：检索失败的兜底（漏掉正确工具是硬伤，比多暴露几个更糟）、常用核心工具常驻不参与检索、工具描述质量直接决定检索质量。
- **项目落点**：可以直接类比项目的 RetrievalPlan 路由——route 决定暴露哪些检索工具，就是一个二选一粒度的 tool retrieval；`knowledge-profile.ts` 用画像帮模型判断该不该调 `search_notes`，就是“工具描述即路由器”的动态版。
- **追问**：tool retrieval 的 false negative 和 false positive 哪个更危险？（false negative——正确工具不在候选集，任务直接不可能完成；多暴露工具只是增加 token 和误选概率。和检索路由的不对称阈值同一结构。）

### Q8. 渐进式能力加载（skills / 说明书模式）和全量 schema 有什么区别？

- **想听**：schema 告诉模型“怎么调”，但复杂能力还需要“什么时候用、怎么组合、有什么坑”——这些放进每个工具描述会爆预算。skills 模式：上下文里只放一行能力索引（名称+一句话触发条件），模型判断相关后再按需读取完整说明书。这是把“能力元数据”也纳入分层上下文管理。
- **项目落点**：项目 Artifact 的“摘要+按需读原文”和这是同一思想，只是对象从工具结果换成能力说明；Prompt Segment 的 priority/tokenBudget 机制可以直接承载能力索引段。
- **追问**：说明书内容被模型读入后如何防止污染后续轮次？（它是 trusted 静态内容时问题不大，但如果说明书可被第三方更新，就回到 Q3 的供应链问题。）

### Q9. 工具描述本身应该怎么评测？

- **想听**：工具描述是路由器，就要按路由器评测：构造“应调用/不应调用/易混淆工具对”三类 case，统计工具选择准确率和误触率；描述改动应像 prompt 改动一样过回归。加分项：用真实 trace 中的误选样本反向修描述。
- **项目落点**：项目 eval 已有 `shouldCallTool` 断言和 routing 独立数据集，缺的只是把“工具描述变更”纳入触发回归的版本描述符——可以直接引用 ReleaseDescriptor 的论点。

---

## 第三层：多智能体编排

### Q10. 什么时候真的需要多 Agent？判断标准是什么？

- **想听**：多 Agent 不是能力升级的默认路径，而是三种约束下的手段——①上下文隔离：单上下文装不下的大范围探索（并行读代码库/多路搜索），子 Agent 各自消耗上下文、只回传结论；②权限隔离：不同步骤需要不同工具/凭证边界；③角色对抗：审查、验证需要独立视角，不能让生成者自己验收。反面判断：能用“单 Agent + 更好的工具/计划”解决的，加 Agent 只会增加协调成本和错误传播。
- **项目落点**：项目 Plan-and-Execute 用 `allowedTools` 实现了②的步骤级权限收窄，用 step system prompt 实现了任务收窄——这说明单 Agent 分步已拿到多 Agent 的部分收益；真正差的是①（步骤共享 loopMessages，没有上下文隔离）和③（没有独立 verifier）。
- **追问**：本项目哪个能力最适合第一个拆成 subagent？（答案应该是独立 verifier（对照 plan success criteria 的语义验收）或深度检索——两者都天然只需要窄上下文和只读工具。）

### Q11. orchestrator-worker 和 peer/swarm 两种拓扑各适合什么？

- **想听**：orchestrator-worker——一个主 Agent 分解任务、分发、汇总，控制流集中、可解释、易设预算，适合可分解的批量任务（大范围调研、迁移、审计）；peer/handoff——Agent 之间平级转交对话所有权，适合“不同阶段需要不同专家”的会话型场景（客服分诊）。关键区别是**谁拥有和用户的对话**：worker 从不直接面对用户，handoff 会转移对话。
- **想听（工程要点）**：无论哪种拓扑，都需要确定性的外层控制——并发上限、总 token 预算、每个子 Agent 的停止条件；不能让协调本身也完全交给模型。
- **项目落点**：项目如果演进，`executePlan` 就是 orchestrator 的雏形（分步、每步预算、失败停止），把“步骤复用同一 loop”改成“步骤派发给带独立上下文的子 loop”即可，不需要引入新框架。

### Q12. Agent 之间 handoff 应该传什么、不传什么？

- **想听**：传 typed 结构——目标、约束、必要证据/产物引用（artifactId 而非原文）、允许的工具/权限、完成标准；不传完整对话 transcript。全量共享上下文的问题：token 浪费、无关信息干扰、权限泄漏（子 Agent 看到它不该看到的用户数据）、注入内容跨 Agent 传播。
- **项目落点**：项目 `PlanStepResultData`（状态/摘要/产物引用）就是步骤间的 typed 传递雏形；Artifact 引用机制正好是“传引用不传原文”的基础设施。记忆题库 Q69 和上下文题库 Q68 的作用域论点（user/workspace/agent/task 分层 + ACL）在这里复用。

### Q13. 子 Agent 说“任务完成了”，orchestrator 应该信吗？

- **想听**：不应该。子 Agent 的自我报告和单 Agent 的“模型说成功”是同一个不可信问题，只是被组织结构放大——错误会被汇总层二次转述而显得更可信。正确做法：子 Agent 回传结构化产物（文件、数据、证据引用），orchestrator 用确定性检查（产物存在、schema 合法、断言通过）或独立 verifier 验收，而不是接受一段“我做完了”的自然语言。
- **项目落点**：项目 plan step 的 verified 判定（loop completed + 无失败工具 + 非空输出）正是这个问题的单 Agent 版本，题库 harness Q43 已承认它不是语义验收——多 Agent 化只会让这个缺口更贵，所以 verifier 应该先于多 Agent 建设。

### Q14. 多 Agent 系统怎么做 eval 和归因（credit assignment）？

- **想听**：端到端成功率之外必须能定位失败层：是分解错（orchestrator 拆了不可能完成的子任务）、路由错（派给了错误角色）、执行错（子 Agent 自身失败）、还是汇总错（子结果正确但合成走样）。这要求每个子 Agent 的输入/输出/停止原因都进入同一棵 trace 树（span tree 的父子关系在这里从“好看”变成“必需”），并对每层分别建 eval case。
- **项目落点**：项目本地 Trace 是平铺步骤、plan 子循环靠重编号合并——单 Agent 下够用，多 Agent 下会最先失效。可以引用可观测性题库 Q12 的 span tree 论点：多 Agent 是把 span tree 从改进项变成前置条件的那个转折点。
- **追问**：子 Agent 的 token 成本怎么核算？（预算必须在 orchestrator 层统一分配和聚合，否则“每个子 Agent 都在预算内、总成本爆炸”。）

### Q15. 两个 Agent 并发修改同一份状态（文件/数据库/记忆）怎么办？

- **想听**：和分布式系统并发写同构，模型不改变问题本质——隔离（每个 Agent 独立工作副本，如 worktree/影子表，完成后合并）、串行化（per-resource 队列或锁）、乐观并发（版本 CAS + 冲突重试）。多 Agent 的特殊点在于合并冲突可能需要语义判断，此时应升级给人或 orchestrator，而不是 last-write-wins。
- **项目落点**：项目已有的对应物——ingestion 的 advisory lock（同页串行）、Snapshot 缺 CAS 的已知缺口（上下文题库 Q52）、记忆并发 last-write-wins（记忆题库 Q44）。回答时把三个现有案例串起来，比空谈理论可信得多。

---

## 第四层：沙箱与执行安全

### Q16. 从 `sandboxed: true` 字段到真正的沙箱，中间隔着什么？

- **想听**：策略声明→enforcement 的完整链条：进程隔离（容器/microVM/gVisor 一类用户态内核）、系统调用过滤（seccomp）、文件系统白名单（只挂载工作目录）、网络策略（默认断网或仅白名单 egress）、资源限制（CPU/内存/超时的 cgroup 级强制而非 `Promise.race`）。核心判据：**恶意代码在里面跑，最坏结果是什么**——答不出这个就没有沙箱。
- **项目落点**：题库 harness Q38 已诚实承认字段未 enforcement。这题的正确姿势是接着说“如果要做，第一个真正需要沙箱的工具是什么”——本项目当前 11 个工具都是受控 API 调用，没有任意代码执行，所以“暂不建沙箱”本身是正确决策；引入代码解释器的那一天才是建沙箱的那一天。
- **追问**：`Promise.race` 超时和 cgroup 限制的本质区别？（前者只是调用方不等了，任务还在消耗资源；后者是 OS 强制终止。harness Q35 的延伸。）

### Q17. 要给 Agent 加一个代码解释器工具，你会怎么设计？

- **想听**：一次性沙箱实例（用完即毁，不跨用户复用）、默认断网（需要网络则走受控代理+白名单）、文件通过显式挂载/上传交换而不是共享宿主目录、输出限额（防止无限打印挤爆上下文——正好接工具结果整形）、执行超时和资源上限、生成代码和执行结果都进 trace。自建 vs 托管沙箱服务的取舍：控制力 vs 运维成本。
- **项目落点**：项目现有机制能直接复用的部分——结果整形/Artifact（大输出落盘给摘要）、riskLevel=confirm（首次执行需确认）、Router 超时框架；缺的是隔离执行环境本身。
- **追问**：模型生成的代码读取了沙箱内的敏感文件再 print 出来，防线在哪？（沙箱防的是逃逸，不防数据外带——所以挂载进沙箱的数据本身要最小化，这是数据面而非执行面的控制。）

### Q18. 统一 egress proxy 相比每个工具各自做出网校验，好在哪里？

- **想听**：单点执行网络策略——DNS 解析后 IP 校验、私网/元数据地址拦截、重定向逐跳重新解析、域名白名单、出网审计都只实现一次；新工具默认继承防护，而不是依赖每个工具作者记得抄一遍校验代码。这是把 SSRF 防护从“代码习惯”变成“架构不变量”。
- **项目落点**：RAG 题库 Q63 已列出 `web_fetch` 的字面校验和 DNS rebinding 缺口；这题是它的架构级答案——与其在 `web-fetch.ts` 里补 DNS 校验，不如让所有出网（web_fetch、webhook、未来的 MCP server 调用）都过同一个受控代理。Scheduler 的 webhook URL 缺 SSRF 校验（总纲 Q2 已承认）正是“各自实现会漏”的现成例证。

### Q19. 沙箱/子进程和主 Agent 之间的数据交换边界怎么设计？

- **想听**：显式、有类型、有大小限制的通道——输入靠挂载指定文件/传参，输出靠约定路径或结构化返回，禁止共享可写的宿主状态。输出回到主上下文前要过和工具结果同样的关卡：截断、整形、不可信标记（沙箱里处理过外部数据，输出就可能携带注入内容）。
- **项目落点**：Artifact 的 userId/会话作用域读取就是现成的交换通道模型；“沙箱输出也是不可信数据”可以直接引用上下文题库 Q55 的 trust 论点。

---

## 第五层：结构化输出与长任务

### Q20. `parseFirstJsonObject` 这类后解析和 provider 原生 structured output 有什么本质区别？

- **想听**：后解析是“生成后修复”——模型自由生成，代码尽力提取，失败靠重试；原生 structured output / constrained decoding 是“生成时约束”——采样阶段就只允许符合 schema 的 token，语法合法性有保证。但原生方案也只保证语法不保证语义（字段值仍可能胡编），且部分 provider 的 schema 子集有限、可能增加延迟。
- **项目落点**：记忆抽取和写入决策当前用 `parseFirstJsonObject` + 确定性校验兜底（记忆题库 Q56），工具调用参数则天然是 provider 的 tool schema 约束——项目里两种模式并存，能对比着讲。正确结论：无论哪种方案，服务端语义校验（证据回指、敏感过滤、业务约束）都不能省。
- **追问**：为什么工具调用是“最早被广泛使用的 structured output”？（tool schema 本质就是带约束的 JSON 生成，provider 为它做了专门训练和解码约束。）

### Q21. 让长任务在进程重启后从中断处继续，最小需要补什么？

- **想听**：durable 的 Run/Step 状态机（数据库而非内存）、每步的输入引用和产物引用（可重建执行现场）、幂等执行（重放已完成步骤不产生二次副作用）、lease/心跳（判断执行者死没死）、resume 入口。ContextSnapshot 只解决“模型上下文可恢复”，不解决“执行进度可恢复”——两者常被混淆。
- **项目落点**：项目里已经有一个正确范本：RAG ingestion queue（原子 claim、attempts、lease、dead 状态）。回答的高分路径是“把 ingestion queue 的可靠性模型推广到 plan step 执行”，而不是引入一个全新的 workflow 引擎名词。harness Q46 列过的清单在这里展开。
- **追问**：哪些 step 可以安全重放？（幂等读可以；副作用步骤需要幂等键或先查后写——接工具题库的 confirm/幂等论点。）

### Q22. 长任务后台化后，产品交互层要解决什么新问题？

- **想听**：至少四个——①进度可见：结构化事件（阶段/百分比/当前动作）而不是无限转圈，SSE 断开后可重连续读；②可干预：暂停/取消/中途追加指令，取消要传播到正在执行的工具（AbortSignal 链路）；③完成通知：用户已离开页面时走通知渠道，结果可回看（落库+Artifact，不能只存在于流里）；④无人值守的权限收窄：后台运行没有实时确认，副作用工具要么预授权要么排队等人（总纲 Scheduler Q5 的论点）。
- **项目落点**：项目的对应物基本齐全，可以逐条映射：结构化 SSE 事件协议（①）、AbortController/`shouldStop` + 中断保存部分回答（②）、agent-task 定时任务落 run 记录（③）、agent-task 的 maxIter=6 与工具集收窄（④）。这题适合作为把 events、runtime、scheduler 三个模块串成一条产品线讲的收尾题。

---

## 项目证据索引

| 能力 | 当前代码 | 面试表达 |
|---|---|---|
| 自建工具目录 | `lib/agent/tools/registry.ts`、`types.ts` | Registry/Schema/Policy 分离，MCP 接入时治理职责留在本地 |
| 策略执行点 | `lib/agent/tools/tool-router.ts` | 风险/确认/限流/超时在服务端调用前 enforcement |
| 工具裁剪（按需暴露雏形） | `retrieval-router.ts`、`tool-intent.ts` | 两层过滤 = tool retrieval 的静态版 |
| 动态工具画像 | `lib/agent/tools/knowledge-profile.ts` | 工具描述即路由器，source hash 缓存 |
| 步骤级权限收窄 | `lib/agent/runtime/plan-execution.ts` | allowedTools = 单 Agent 拿到的多 Agent 部分收益 |
| typed 步骤传递 | `PlanStepResultData` | handoff“传结构不传 transcript”的雏形 |
| 出网防护现状 | `lib/agent/tools/web-fetch.ts` | 字面校验已有，DNS 级与统一 egress proxy 是缺口 |
| durable 队列范本 | `lib/knowledge/ingestion-queue.ts` | 原子 claim/lease/退避/dead，可推广到 step 执行 |
| 无人值守 Agent | `lib/scheduler/handlers/index.ts` | agent-task 收窄迭代数与工具集 |
| 后解析+校验兜底 | 记忆抽取 `parseFirstJsonObject` 链路 | 与 provider tool schema 约束并存对比 |

---

## 一句话复习版

1. MCP 标准化工具的发现与传输，权限、确认、限流、审计、租户隔离永远留在自己这一侧。
2. 第三方工具描述、schema 和结果都是不可信输入，供应链治理与 RAG 注入治理同构。
3. 工具规模化的答案是分层暴露：核心常驻 + 检索式选择 + 说明书按需加载，本质是把上下文管理用到工具元数据上。
4. 多 Agent 是上下文隔离、权限隔离、角色对抗三种约束下的手段，不是默认升级路径。
5. handoff 传 typed 结构和产物引用，不传完整 transcript；子 Agent 自报成功和模型自报成功同样不可信。
6. 多 Agent 让 span tree、统一预算和独立 verifier 从改进项变成前置条件。
7. 沙箱的判据是“恶意代码在里面跑最坏怎样”；没有任意代码执行的工具集，不建沙箱本身就是正确决策。
8. 出网防护应收敛到统一 egress proxy，把 SSRF 防线从代码习惯变成架构不变量。
9. Snapshot 恢复上下文，durable Run/Step 恢复执行进度，两者不能混为一谈；项目的 ingestion queue 是现成的可靠性范本。
10. 这份题库的最高分答法永远是：当前形态为什么够用 + 规模化的第一步改什么 + 用什么指标验证。
