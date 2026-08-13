import type { ExtractedFact, MemoryWriteDecision } from "@/lib/agent/memory/memory-flow";
import type { MemoryRecord } from "@/lib/agent/memory/types";

/**
 * 记忆召回与写入判定的 eval case 集。
 *
 * 为什么它必须先于权重与融合改动落地：datasets/ 下已有 RAG 与
 * Retrieval Routing 测试集，但记忆这条线一直没有基线。没有基线的阈值调整和
 * 融合策略切换是盲调——改完只知道「跑起来了」，不知道变好还是变坏。
 *
 * 三条执行纪律写在类型里而不只写在文档里：
 *
 * 1. `expectation: "known_red"` —— 中文罕见专名那条在关键词通道第一步阶段
 *    **预期是红的**。不显式标出来，跑出红色会被误读成「实现有 bug」，
 *    或者更糟：被误读成「中文分词已经做完了但没生效」。
 * 2. 专名 case 按「数字 / Latin token / 中文专名」拆成三条，不合并成一条中文样本。
 *    第一步只覆盖数字与 Latin，用中文样本测第一步会得出「关键词通道无效」的错误结论。
 * 3. 融合策略**不预设赢家**：fusion_ab 那组要跑满 vector-only / weighted / RRF
 *    三组。若关键词通道的增量小于噪声，5.5 整节都不该做。
 */

export type MemoryEvalKind =
  /** 只依赖入口正则，纯函数，可离线跑。 */
  | "recall_gate"
  /** 只依赖写入判定的确定性分支，候选可以手造，可离线跑。 */
  | "write_decision"
  /** 需要真实向量库与 embedding 服务。 */
  | "retrieval_quality"
  /** 需要真实 Postgres：归档区间、并发反序、硬删除。 */
  | "storage_semantics"
  /** 融合策略三方对照，需要真实检索链路。 */
  | "fusion_ab";

export type MemoryEvalExpectation =
  /** 现在就应该是绿的；变红就是回归。 */
  | "pass"
  /**
   * 现在预期是红的，且**红本身是正确状态**。
   * 必须写明 `unblockedBy`：不写就无法区分「还没做」与「做完了但坏了」。
   */
  | "known_red";

export type MemoryRecallGateCase = {
  id: string;
  kind: "recall_gate";
  query: string;
  /** true = 应当召回长期记忆；false = 不应召回（防误召回）。 */
  expectedEligible: boolean;
  why: string;
  expectation?: MemoryEvalExpectation;
  unblockedBy?: string;
};

export type MemoryWriteDecisionCase = {
  id: string;
  kind: "write_decision";
  fact: ExtractedFact;
  candidates: MemoryRecord[];
  /** 允许多个：确定性分支返回 null 时会交给模型，此处只断言确定性部分能接受的结果集。 */
  expectedActions: MemoryWriteDecision["action"][];
  /** 期望的目标 key；省略表示不约束。 */
  expectedTargetKey?: string;
  expectedSupersedeKind?: "evolution" | "correction" | "invalidation";
  why: string;
  expectation?: MemoryEvalExpectation;
  unblockedBy?: string;
};

/** 需要外部依赖、当前只作为待办清单存在的 case。跑 CI 时跳过，不删除。 */
export type MemoryIntegrationCase = {
  id: string;
  kind: "retrieval_quality" | "storage_semantics" | "fusion_ab";
  /** 先要写入哪些记忆（内容 + key）。 */
  seed: Array<{ key: string; content: string }>;
  /** 然后问什么。storage_semantics 里可能是一串操作而非提问。 */
  probe: string;
  /** 期望结果的自然语言描述——断言细节依赖真实 store，写死在这里只会过时。 */
  expected: string;
  why: string;
  expectation: MemoryEvalExpectation;
  unblockedBy?: string;
  /**
   * 融合 A/B 跑分器要用的机器可判定形态。
   *
   * 为什么不直接解析 `expected`：那是给人看的散文，而 hit@1 / hit@3 需要
   * 「问哪一句、哪些 key 算命中」这两个确定值。只有单轮提问的 case 能填，
   * 多步操作型 probe（先改再问、并发写入）填不了 —— 那些 case 会被跑分器
   * **显式跳过并列出来**，而不是静默漏掉。
   *
   * `expectedKeys: []` 表示「应当一条都不召回」（防误召回 case）。
   */
  ab?: { query: string; expectedKeys: string[] };
};

export type MemoryEvalCase =
  | MemoryRecallGateCase
  | MemoryWriteDecisionCase
  | MemoryIntegrationCase;

function fact(overrides: Partial<ExtractedFact> & Pick<ExtractedFact, "fact" | "key">): ExtractedFact {
  return {
    type: "fact",
    source: "user_explicit",
    confidence: 0.9,
    importance: 0.7,
    evidenceExcerpt: overrides.fact,
    intent: "upsert",
    ...overrides,
  };
}

function memory(
  key: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id: `mem-${key}`,
    key,
    layer: "semantic",
    type: "fact",
    source: "user_explicit",
    confidence: 0.9,
    importance: 0.7,
    status: "active",
    content,
    evidence: null,
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    validFrom: "2026-07-01T00:00:00.000Z",
    validTo: null,
    lastAccessedAt: null,
    version: 1,
    ...overrides,
  };
}

// ============================================================
// ① 入口门控（可离线跑）
// ============================================================
export const memoryRecallGateCases: MemoryRecallGateCase[] = [
  {
    id: "gate-temporal-budget",
    kind: "recall_gate",
    query: "我之前购车预算是多少",
    expectedEligible: true,
    why: "本文的起因场景。原有 40 多个动词分支要求「之前」紧跟动词（之前说/之前聊），这句整条不匹配，一条记忆都不召回，模型只能裸答。",
  },
  {
    id: "gate-temporal-location",
    kind: "recall_gate",
    query: "以前我住哪个城市",
    expectedEligible: true,
    why: "同一类句式：时间指代 + 疑问词，不含任何记忆动词。",
  },
  {
    id: "gate-temporal-plan",
    kind: "recall_gate",
    query: "当初定的目标是什么",
    expectedEligible: true,
    why: "时间指代词覆盖到「当初」。",
  },
  // 负例是止血正则的前置条件，不是补充测试。
  // 误召回比不召回更糟：模型会把无关的个人事实当成用户已确认的前提去推理。
  {
    id: "gate-negative-regex",
    kind: "recall_gate",
    query: "上次那个正则怎么写的",
    expectedEligible: false,
    why: "技术追问里「上次 + 疑问词」极其常见。放宽入口若不配套排除项，会把无关个人记忆注入 prompt。",
  },
  {
    id: "gate-negative-error",
    kind: "recall_gate",
    query: "之前的报错是什么原因",
    expectedEligible: false,
    why: "同上，报错排查不需要个人背景。",
  },
  {
    id: "gate-negative-weather",
    kind: "recall_gate",
    query: "之前的天气怎么样",
    expectedEligible: false,
    why: "公开信息类提问，答案不在记忆里。",
  },
  {
    id: "gate-negative-statement",
    kind: "recall_gate",
    query: "之前我们讨论过这个",
    expectedEligible: false,
    why: "只有时间指代、没有疑问词，是陈述句，不构成检索需求。",
  },
];

// ============================================================
// ② 写入判定（可离线跑）
// ============================================================
export const memoryWriteDecisionCases: MemoryWriteDecisionCase[] = [
  {
    id: "write-same-key-evolution",
    kind: "write_decision",
    fact: fact({ fact: "用户的购车预算是 8 万", key: "budget:car" }),
    candidates: [memory("budget:car", "用户的购车预算是 5 万")],
    expectedActions: ["UPDATE"],
    expectedTargetKey: "budget:car",
    expectedSupersedeKind: "evolution",
    why: "同一业务 key 是唯一能授权 UPDATE 的信号。旧值曾经为真，按 evolution 归档。",
  },
  {
    id: "write-same-key-correction",
    kind: "write_decision",
    fact: fact({
      fact: "用户的购车预算是 8 万",
      key: "budget:car",
      intent: "correct",
      type: "correction",
    }),
    candidates: [memory("budget:car", "用户的购车预算是 5 万")],
    expectedActions: ["UPDATE"],
    expectedTargetKey: "budget:car",
    expectedSupersedeKind: "correction",
    why: "「其实是 8w」意味着 5w 从未为真，归档时 effective_to 必须等于 effective_from，而不是截到现在。",
  },
  {
    id: "write-different-slot-not-merged",
    kind: "write_decision",
    fact: fact({ fact: "用户的购车首付预算是 8 万", key: "budget:car:down_payment" }),
    candidates: [memory("budget:car", "用户的购车预算是 30 万", { score: 0.93 })],
    // 确定性分支在这里必须拒绝猜测：没有 exact key，却有高相似候选。
    // 结果是 NOOP（漏写，可恢复），而不是 UPDATE（把两笔钱合并，不可恢复）。
    expectedActions: ["NOOP"],
    why: "购车预算与首付预算是两笔钱。语义相似度 0.93 不构成同一槽位的证据；判错方向必须偏向漏写。",
  },
  {
    id: "write-like-vs-allergy",
    kind: "write_decision",
    fact: fact({ fact: "用户对香菜过敏", key: "diet:allergy", type: "fact" }),
    candidates: [memory("diet:preference", "用户喜欢吃香菜", { score: 0.91 })],
    expectedActions: ["NOOP"],
    why: "语义极近、结论相反。误合并的后果不是答错一句话，是给出会让用户过敏的建议。",
  },
  {
    id: "write-different-food-preferences-coexist",
    kind: "write_decision",
    fact: fact({ fact: "用户喜欢吃香菜", key: "diet:food:香菜", type: "preference" }),
    candidates: [memory("diet:preference", "用户喜欢吃土豆", { score: 0.93, type: "preference" })],
    expectedActions: ["ADD"],
    expectedTargetKey: "diet:food:香菜",
    why: "饮食喜好是多值集合。不同食物必须使用不同 key 并存，语义相似度不能让土豆覆盖香菜。",
  },
  {
    id: "write-low-similarity-add",
    kind: "write_decision",
    fact: fact({ fact: "用户是后端工程师", key: "profile:occupation" }),
    candidates: [],
    expectedActions: ["ADD"],
    expectedTargetKey: "profile:occupation",
    why: "没有任何候选时不存在可覆盖或可重复的对象，直接新增。",
  },
  {
    id: "write-forget-invalidates",
    kind: "write_decision",
    fact: fact({
      fact: "用户不再住在杭州",
      key: "location:residence",
      intent: "forget",
      type: "correction",
    }),
    candidates: [memory("location:residence", "用户住在杭州")],
    expectedActions: ["INVALIDATE"],
    expectedTargetKey: "location:residence",
    expectedSupersedeKind: "invalidation",
    why: "事实不再成立但可以留档：软失效 + 归档，历史仍可查。",
  },
  {
    id: "write-purge-hard-deletes",
    kind: "write_decision",
    fact: fact({
      fact: "用户要求不再保存居住地",
      key: "location:residence",
      intent: "purge",
      type: "correction",
    }),
    candidates: [memory("location:residence", "用户住在杭州")],
    expectedActions: ["PURGE"],
    expectedTargetKey: "location:residence",
    why: "「忘记我住哪里」是删除信息本身，不是记录一次事实变化。软失效之后 search_memory_history 仍能翻出来，等于没做到。",
  },
  {
    id: "write-purge-on-invalidated-row",
    kind: "write_decision",
    fact: fact({
      fact: "用户要求不再保存居住地",
      key: "location:residence",
      intent: "purge",
      type: "correction",
    }),
    candidates: [memory("location:residence", "用户住在杭州", { status: "invalidated" })],
    expectedActions: ["PURGE"],
    expectedTargetKey: "location:residence",
    why: "purge 刻意不看 status：已软失效的行仍留在三张表里，且能被历史工具检索。",
  },
  {
    id: "write-forget-ambiguous-refuses",
    kind: "write_decision",
    fact: fact({
      fact: "用户不再需要那条记录",
      key: "unknown:target",
      intent: "forget",
      type: "correction",
    }),
    candidates: [
      memory("location:residence", "用户住在杭州", { score: 0.6 }),
      memory("location:workplace", "用户在上海工作", { score: 0.58 }),
    ],
    // 确定性分支给不出答案时返回 null 交给模型；模型输出无效时兜底是 NOOP。
    // 断言的是「不会误删」，而不是某个具体动作。
    expectedActions: ["NOOP"],
    why: "删除目标含糊时宁可不做。删错的代价不可恢复，问一句的代价是一次追问。",
  },
];

// ============================================================
// ③ 需要外部依赖的 case（当前跳过，作为待办清单保留）
// ============================================================
export const memoryIntegrationCases: MemoryIntegrationCase[] = [
  {
    id: "retrieval-number-query",
    kind: "retrieval_quality",
    seed: [{ key: "budget:car", content: "用户的购车预算是 8 万" }],
    probe: "我预算是 8w 还是 5w",
    expected: "召回 budget:car，且内容里的 8 万可见",
    why: "本文起因场景的检索侧。数字在向量空间里几乎不可分——「8 万」与「5 万」的余弦距离极近，纯向量通道分不开，需要关键词通道的第一步。",
    // 代码已落地（match_memories_keyword + 数字 term），但**在真实库上跑过之前
    // 仍然记为 known_red**：改红绿状态的依据是跑分结果，不是「我写完了」。
    expectation: "known_red",
    unblockedBy: "5.5 第一步：数字 / Latin token 关键词通道（代码已落地，待真实库跑分确认）",
    ab: { query: "我预算是 8w 还是 5w", expectedKeys: ["budget:car"] },
  },
  {
    id: "retrieval-latin-model",
    kind: "retrieval_quality",
    seed: [{ key: "preference:car_model", content: "用户想买 Model Y" }],
    probe: "Model Y 的续航够我用吗",
    expected: "召回 preference:car_model",
    why: "Latin token 通道。to_tsvector('simple') 对 Latin 词本来就能切，这条的成本最低。",
    expectation: "known_red",
    unblockedBy: "5.5 第一步：数字 / Latin token 关键词通道（代码已落地，待真实库跑分确认）",
    ab: { query: "Model Y 的续航够我用吗", expectedKeys: ["preference:car_model"] },
  },
  {
    id: "retrieval-chinese-rare-term",
    kind: "retrieval_quality",
    seed: [{ key: "diet:allergy", content: "用户对香菜过敏" }],
    probe: "我对香菜过敏吗",
    expected: "召回 diet:allergy",
    // ⚠️ 这条**预期是红的**，而且红是正确状态。
    // 第一步只做数字与 Latin token，中文专名要等 Intl.Segmenter 切词。
    // 不标出来，跑出红会被误读成实现有 bug；标成 pass 会被误读成中文分词已完成。
    why: "中文专名通道。to_tsvector('simple') 不切中文，整句会变成一个 token，关键词通道对它完全无效。",
    expectation: "known_red",
    unblockedBy: "5.5 第二步：Intl.Segmenter 中文切词 + 停用词表（代码已落地，待真实库跑分确认）",
    ab: { query: "我对香菜过敏吗", expectedKeys: ["diet:allergy"] },
  },
  {
    id: "retrieval-only-current-value",
    kind: "retrieval_quality",
    seed: [{ key: "budget:car", content: "用户的购车预算是 5 万" }],
    probe: "先把预算改成 8 万，然后问我预算多少",
    expected: "只召回 8 万这一条，历史里的 5 万不出现在召回结果中",
    why: "验证历史表不进向量表这个决定。历史版本若带 embedding 进 HNSW，会挤占 match_count 名额（filtered-ANN），当前值召回条数变少甚至召不回。",
    expectation: "pass",
  },
  {
    id: "retrieval-cross-key-ranking",
    kind: "retrieval_quality",
    seed: [
      { key: "location:residence", content: "用户住在杭州" },
      { key: "location:workplace", content: "用户在上海工作" },
    ],
    probe: "我住哪儿",
    expected: "location:residence 排在 location:workplace 之前",
    why: "跨 key 干扰。两条内容语义极近，排序错了答案就错。",
    expectation: "pass",
    // hit@1 才是这条的重点：两条都被召回不算对，residence 必须排第一。
    ab: { query: "我住哪儿", expectedKeys: ["location:residence"] },
  },
  {
    id: "retrieval-unrelated-query",
    kind: "retrieval_quality",
    seed: [{ key: "diet:allergy", content: "用户对香菜过敏" }],
    probe: "帮我把这段代码改成 TypeScript",
    expected: "不召回任何记忆",
    why: "防误召回。放宽入口正则之后，这条是唯一能发现「放宽过度」的信号。",
    expectation: "pass",
    // 这条是关键词通道的**负例**，必须留在 A/B 集里：关键词通道天然倾向多召回，
    // 只看正例会得出「融合全面变好」的结论，而代价（噪声）恰好落在这类查询上。
    ab: { query: "帮我把这段代码改成 TypeScript", expectedKeys: [] },
  },
  {
    id: "storage-correction-interval",
    kind: "storage_semantics",
    seed: [{ key: "budget:car", content: "用户的购车预算是 5 万" }],
    probe: "以 intent=correct 写入「其实是 8 万」",
    expected: "历史行的 effective_to 等于它自己的 effective_from，supersede_kind = 'correction'",
    why: "correction 意味着旧值从未为真，有效期必须归零。若按 evolution 截到「用户表达新值的时刻」，历史会声称 5w 曾经真的成立过一段时间。",
    expectation: "pass",
  },
  {
    id: "storage-recorded-at-is-old-created-at",
    kind: "storage_semantics",
    seed: [{ key: "budget:car", content: "用户的购车预算是 5 万" }],
    probe: "覆盖成 8 万后检查历史行",
    expected: "recorded_at 等于旧行原本的 created_at；superseded_at 才是归档时刻",
    why: "写错这一列，记录时间轴就废了——「系统在某时刻认为什么是真的」这类查询会全部答错。",
    expectation: "pass",
  },
  {
    id: "storage-out-of-order-consolidation",
    kind: "storage_semantics",
    seed: [{ key: "budget:car", content: "用户的购车预算是 5 万" }],
    probe: "让 effective_at 较早的那次固化后完成（模拟 fire-and-forget 反序）",
    expected: "当前 active 值仍是用户最后表达的 8 万；迟到的 5 万只补一段历史区间",
    why: "固化是 void consolidate，两次固化可以重叠并反序完成。没有反序保护，用户会看到「我明明改成 8w 了」。",
    expectation: "pass",
  },
  {
    id: "storage-version-conflict-retry",
    kind: "storage_semantics",
    seed: [{ key: "budget:car", content: "用户的购车预算是 5 万" }],
    probe: "两个并发固化带同一个 expected_version 写入",
    expected: "一个成功，另一个收到 40001 后重读候选并重做判定，历史表里只有一条归档",
    why: "FOR UPDATE 只保证不同时写，不保证后写者知道自己在覆盖什么。少了版本校验，历史表会出现重复归档。",
    expectation: "pass",
  },
  {
    id: "storage-purge-removes-history",
    kind: "storage_semantics",
    seed: [{ key: "location:residence", content: "用户住在杭州" }],
    probe: "「忘记我住哪里」之后分别调用 recall_memory 与 search_memory_history",
    expected: "两个工具都查不到任何与居住地相关的记录",
    why: "历史表上线而 purge 未上线是净退步：软失效后信息本来进不了 prompt，有了历史工具反而能被翻出来。",
    expectation: "pass",
  },
  {
    id: "storage-semantic-near-duplicate",
    kind: "storage_semantics",
    seed: [{ key: "diet:restriction", content: "用户不吃辣" }],
    probe: "换措辞再说一次「我吃不了辣的」，触发二次抽取",
    expected: "最终只有 1 条 active",
    why: "同一事实换措辞若产生第二条 active，用户会同时看到两条互相印证或互相矛盾的记忆，且都无法通过「忘记」一次清掉。",
    expectation: "pass",
  },
  // 融合三方对照：不预设赢家。
  // weighted 与 RRF 的差别在于 RRF 只看排名、丢弃分数量级；记忆的候选池只有约 12 条，
  // 分数量级恰恰携带信息（0.91 与 0.52 的差距不该被压成「第 1 名与第 2 名」）。
  // 但这是推理，不是数据——所以必须跑满三组，包括 vector-only 对照组。
  // 若关键词通道的增量小于噪声，5.5 整节都不该做。
  {
    id: "fusion-ab-vector-only",
    kind: "fusion_ab",
    seed: [],
    probe: "在上面全部 retrieval_quality case 上跑 vector-only",
    expected: "记录 hit@1 / hit@3 作为对照基线",
    why: "对照组。没有它，任何「融合有效」的结论都无法证伪。",
    expectation: "pass",
  },
  {
    id: "fusion-ab-weighted",
    kind: "fusion_ab",
    seed: [],
    probe: "跑 0.7 × vector + 0.3 × text，复用 calibrateListScore",
    expected: "记录 hit@1 / hit@3",
    why: "候选池小、分数量级有意义时，加权融合理论上优于纯排名融合。需要数据验证。",
    expectation: "pass",
  },
  {
    id: "fusion-ab-rrf",
    kind: "fusion_ab",
    seed: [],
    probe: "跑 RRF（k = 60，与 rag 侧配置一致）",
    expected: "记录 hit@1 / hit@3",
    why: "项目 rag 侧已有 RRF 实现与 rrfK 配置，复用成本最低。若它不输 weighted，就该选它。",
    expectation: "pass",
  },
];

export const memoryEvalCases: MemoryEvalCase[] = [
  ...memoryRecallGateCases,
  ...memoryWriteDecisionCases,
  ...memoryIntegrationCases,
];
