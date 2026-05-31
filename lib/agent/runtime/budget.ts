import type Anthropic from "@anthropic-ai/sdk";

/**
 * Agent Loop 的上下文预算工具。
 *
 * 模型本身是无状态的，每一轮能看到什么，完全取决于我们传入的 messages。
 * 如果 loopMessages 不断追加工具调用和工具结果，最终会把 context window 塞满。
 * 这个文件先用“字符数 / 4”的粗略估算来建立预算意识，后续可以替换成真实 tokenizer。
 */
export type ModelMessage = Anthropic.MessageParam;

/**
 * 预留给后续 trace / eval 使用的 token 汇总结构。
 * 当前阶段先实现估算和预算控制，后面可以把真实模型返回的 usage 填进来。
 */
export type TokenUsage = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
};

/**
 * 一个简单的硬预算计数器。
 *
 * max 表示本次 Agent Loop 最多允许消耗的估算 token；
 * spent 表示已经消耗的估算 token。
 */
export class TokenBudget {
  constructor(
    public readonly max: number,
    public spent = 0,
  ) {}

  /** 返回当前预算还剩多少。 */
  remaining() {
    return Math.max(0, this.max - this.spent);
  }

  /** 判断下一次操作需要的 token 是否还在预算内。 */
  canAfford(tokens: number) {
    return this.remaining() >= tokens;
  }

  /** 记录一次 token 消耗，负数会被当成 0，避免把预算倒加回去。 */
  spend(tokens: number) {
    this.spent += Math.max(0, tokens);
  }
}

/**
 * 粗略 token 估算。
 *
 * 英文场景里常用经验值是 1 token ~= 4 chars。
 * 中文不完全准确，但足够用于学习阶段的“防爆 context”硬保护。
 */
export function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4);
}

/**
 * 对任意结构估算 token。
 *
 * messages / content block 通常是对象或数组，所以先序列化成 JSON 再估算。
 */
export function estimateTokens(value: unknown): number {
  if (typeof value === "string") {
    return estimateTokensFromText(value);
  }

  return estimateTokensFromText(JSON.stringify(value));
}

/**
 * 截断过长的工具结果。
 *
 * 工具结果会被作为 tool_result 重新塞回模型上下文，如果 RAG 一次返回很多长文档，
 * 单个工具结果就可能吃掉大量 context。这里限制“给模型看的内容”长度，同时保留
 * truncated / originalChars 元数据，方便前端或 trace 知道发生过截断。
 */
export function truncateToolContent(
  content: string,
  maxTokens: number,
): {
  content: string;
  truncated: boolean;
  originalChars: number;
} {
  const estimated = estimateTokensFromText(content);

  if (estimated <= maxTokens) {
    return {
      content,
      truncated: false,
      originalChars: content.length,
    };
  }

  const maxChars = maxTokens * 4;
  return {
    content:
      content.slice(0, maxChars) +
      `\n\n...（已截断，原始长度 ${content.length} 字符，约 ${estimated} tokens）`,
    truncated: true,
    originalChars: content.length,
  };
}
