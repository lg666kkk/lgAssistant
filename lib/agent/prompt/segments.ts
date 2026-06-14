/**
 * Prompt 段化（Prompt Pipe 的最小内核）。
 *
 * 注入侧的 system prompt 之前在 route.ts 里裸字符串拼接，trace 只能看到拼好的整段，
 * 无法区分「哪段是记忆、哪段是策略」。这里把组装拆成「段（segment）」：
 *   - buildSegments：按输入数据构造出有结构的段数组
 *   - renderSegments：把段数组拼成模型消费的 system 字符串
 *
 * 段数组同时写进 trace（见 ModelTraceStep.systemSegments），详情页就能按段分块展示。
 *
 * 当前只做「段化 + 渲染」，不做优先级裁剪 / token 预算 —— 那是后续完整 Prompt Pipe 的事。
 */

export type PromptSegmentKind = "identity" | "memory" | "web-search-policy";

export type PromptSegment = {
  kind: PromptSegmentKind;
  title: string; // 给人看的段名，trace 详情页分块标题用
  content: string; // 段正文；空内容的段不会被构造出来
};

// 基础身份段：给模型统一的角色与行为约束。
// 之前注入侧完全没有身份段，模型行为全靠默认；这里补一段简短的。
const IDENTITY_CONTENT = `你是一个个人知识助手。你可以调用工具（如联网搜索、知识库检索、计算、时间等）来完成任务。
回答时优先基于检索到的资料和已知的用户记忆，不要杜撰来源或事实；信息不足时如实说明。`;

const WEB_SEARCH_CONTENT = `用户已开启联网搜索。处理本轮问题时：
- 优先调用 web_search 获取公开网页信息，并基于搜索结果作答；不要只依赖模型内部知识。
- 如果问题涉及今天、最新、近期、价格、政策、版本、人物职位、赛事赛程等可能变化的信息，**必须先单独调用 get_current_time，等到拿到时间结果后，再在下一步调用 web_search**，query 中带上真实日期。不得在同一步骤中同时调用 get_current_time 和 web_search。
- 如果问题不依赖实时信息，可直接搜索核心事实或背景资料，不必额外查询当前时间。
- 不要用多个近义 query 重复搜索同一意图。
- 默认每轮最多调用 2 次 web_search（含因先查时间而产生的第二次）。只有用户明确要求深度研究、比较多个来源或事实冲突时，才允许更多调用。
- 回答时明确区分「搜索结果直接支持的事实」和你的综合判断；资料不足或来源冲突时，请说明不确定性。`;

export type BuildSegmentsInput = {
  includeIdentity?: boolean; // 是否注入基础身份段，默认 true
  memory?: string; // recallForPrompt 的返回（已是成段文本），空串则不构造记忆段
  webSearchEnabled?: boolean; // 开启联网搜索 → 构造策略段
};

/**
 * 按输入构造段数组。顺序即注入顺序：身份 → 记忆 → 策略。
 * 空内容的段直接跳过，不产出。
 */
export function buildSegments(input: BuildSegmentsInput): PromptSegment[] {
  const segments: PromptSegment[] = [];

  if (input.includeIdentity !== false) {
    segments.push({
      kind: "identity",
      title: "身份",
      content: IDENTITY_CONTENT,
    });
  }

  const memory = input.memory?.trim();
  if (memory) {
    segments.push({
      kind: "memory",
      title: "记忆",
      content: memory,
    });
  }

  if (input.webSearchEnabled) {
    segments.push({
      kind: "web-search-policy",
      title: "联网搜索策略",
      content: WEB_SEARCH_CONTENT,
    });
  }

  return segments;
}

/**
 * 把段数组拼成模型消费的 system 字符串。段间用空行分隔，与改造前的拼接格式保持一致。
 * 段为空时返回空字符串（调用方据此决定是否注入 system）。
 */
export function renderSegments(segments: PromptSegment[]): string {
  return segments.map((s) => s.content).join("\n\n");
}
