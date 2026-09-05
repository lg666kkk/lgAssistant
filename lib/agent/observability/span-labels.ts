// Langfuse 上报的 span/generation 名字是英文技术标识（retrieval.route、memory.recall…），
// 在 trace 树里不看代码很难一眼说清这一步在干什么。
// 这里维护「英文 span 名 → 中文作用说明」的唯一映射，所有上报点统一带上
// metadata.spanLabel 字段，详情页/回放都能直接读到中文语义。
export const SPAN_LABEL_METADATA_KEY = "spanLabel" as const;

// 未登记时的兜底文案：宁可显式说「没登记」，也不要留空字段让人以为漏报。
export const UNKNOWN_SPAN_LABEL = "未登记环节";

// key 为 span 名或其前缀段（用 ":" 分隔的第一段），value 为中文作用。
export const SPAN_LABELS: Record<string, string> = {
  // ── 请求主链路 ──
  "agent-chat": "对话主链路（一次聊天请求的根 trace）",
  "execution.strategy": "执行策略（子目标、依赖与计划审核要求）",
  "knowledge-sync": "知识库同步",
  "knowledge-wiki-compile": "Wiki 页面编译请求",

  // ── 检索与证据 ──
  // 动态检索名使用 retrieval.<source>:<toolName>。resolveSpanLabel 会按冒号
  // 回退到来源级标签；调用方还会把具体 toolName 写入 spanLabel 和 metadata。
  "retrieval.route": "检索路由决策（判断走知识库还是联网）",
  "retrieval.web": "Web 证据检索",
  "retrieval.knowledge": "个人知识库检索",
  "retrieval.unknown": "外部证据检索（来源未知）",
  "evidence.validation": "回答证据校验（引用与事实一致性打分）",

  // ── 记忆 ──
  "memory.recall": "记忆召回（把相关长期记忆注入 system）",
  "memory.rerank": "记忆重排（Qwen3 对候选记忆重新评分）",
  "memory.explicit_forget": "显式遗忘处理（用户要求忘掉某条记忆）",
  "memory.consolidate": "记忆固化（把本轮对话沉淀成长期记忆）",
  "user-profile.load": "用户画像加载（把用户确认的稳定画像注入上下文）",

  // ── 上下文工程 ──
  "context.compaction": "上下文压缩（超预算时裁剪/摘要历史）",
  "conversation-context-compress": "会话历史语义压缩（压缩模型调用）",

  // ── Agent 循环里的模型调用 ──
  "agent-loop-initial": "Agent 首轮模型推理（还没有工具结果）",
  "agent-loop-after-tools": "Agent 工具结果回灌后的模型推理",
  "agent-loop-model-call": "Agent 循环模型调用",
  "final-answer-stream": "最终答案流式生成",
  "generate-text": "通用一次性文本生成",

  // ── 规划 ──
  "plan-and-execute-planner": "任务规划（Plan-and-Execute 拆步骤）",
  "plan-and-execute-planner:repair": "规划结果 JSON 修复重试",

  // ── 知识加工 ──
  "knowledge-profile-compress": "知识画像压缩",
  "wiki-page-compile": "Wiki 正文编译（模型生成）",
};

/**
 * 解析 span 名对应的中文作用说明。
 * 动态名（agent-loop-after-tools:search_notes+read_tool_artifact、
 * plan-and-execute-planner:ai-sdk）按 ":" 逐段回退，优先取最长匹配。
 */
export function resolveSpanLabel(name: string): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return UNKNOWN_SPAN_LABEL;

  const segments = trimmed.split(":");
  for (let end = segments.length; end > 0; end--) {
    const candidate = segments.slice(0, end).join(":");
    const label = SPAN_LABELS[candidate];
    if (label) return label;
  }
  return UNKNOWN_SPAN_LABEL;
}

/**
 * 给 metadata 补上中文标识。已显式写了 spanLabel 的调用方保持不变（允许覆盖）。
 */
export function withSpanLabel<T extends Record<string, unknown>>(
  name: string,
  metadata?: T,
): T & Record<typeof SPAN_LABEL_METADATA_KEY, string> {
  const existing = metadata?.[SPAN_LABEL_METADATA_KEY];
  return {
    ...(metadata ?? ({} as T)),
    [SPAN_LABEL_METADATA_KEY]: typeof existing === "string" && existing
      ? existing
      : resolveSpanLabel(name),
  };
}

/**
 * 构造可以安全传给 propagateAttributes() 的共享 metadata。
 *
 * propagateAttributes 会把 metadata 继承给所有后代 observation，而 spanLabel
 * 描述的是某一个具体 observation，不能继承。即使调用方误传了根标签，这里也
 * 会将其剥离，避免覆盖 retrieval.route、context.compaction、模型调用等子 span 标签。
 */
export function toSharedTraceMetadata<T extends Record<string, unknown>>(
  metadata: T,
): Omit<T, typeof SPAN_LABEL_METADATA_KEY> {
  const { [SPAN_LABEL_METADATA_KEY]: _spanLabel, ...shared } = metadata;
  return shared;
}
