import { countTokens, decode, encode } from "gpt-tokenizer";

/**
 * 本地 token 估算器。
 *
 * 这里使用 OpenAI o200k_base tokenizer 作为 DeepSeek OpenAI-compatible
 * 调用的近似估算。真实计费仍以 provider 返回的 usage 为准；本模块只用于
 * 请求前的上下文预算、工具结果截断和 prompt segment 裁剪。
 */
export function countTokensFromText(text: string): number {
  if (!text) return 0;
  try {
    return countTokens(text);
  } catch {
    return fallbackEstimateTokens(text);
  }
}

export function countTokensForValue(value: unknown): number {
  if (typeof value === "string") {
    return countTokensFromText(value);
  }

  return countTokensFromText(JSON.stringify(value));
}

export function truncateTextByTokens(
  text: string,
  maxTokens: number,
): {
  content: string;
  tokenCount: number;
  truncated: boolean;
} {
  if (maxTokens <= 0) {
    return {
      content: "",
      tokenCount: countTokensFromText(text),
      truncated: text.length > 0,
    };
  }

  try {
    const tokens = encode(text);
    if (tokens.length <= maxTokens) {
      return {
        content: text,
        tokenCount: tokens.length,
        truncated: false,
      };
    }

    return {
      content: decode(tokens.slice(0, maxTokens)),
      tokenCount: tokens.length,
      truncated: true,
    };
  } catch {
    const tokenCount = fallbackEstimateTokens(text);
    if (tokenCount <= maxTokens) {
      return {
        content: text,
        tokenCount,
        truncated: false,
      };
    }

    const maxChars = maxTokens * 4;
    return {
      content: text.slice(0, maxChars),
      tokenCount,
      truncated: true,
    };
  }
}

export function sliceTextByTokens(
  text: string,
  offset: number,
  limit: number,
): {
  content: string;
  totalTokens: number;
  endOffset: number;
  nextOffset: number | null;
  hasMore: boolean;
} {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.floor(limit));

  try {
    const tokens = encode(text);
    const end = Math.min(tokens.length, safeOffset + safeLimit);
    return {
      content: decode(tokens.slice(safeOffset, end)),
      totalTokens: tokens.length,
      endOffset: end,
      nextOffset: end < tokens.length ? end : null,
      hasMore: end < tokens.length,
    };
  } catch {
    const charsPerToken = 4;
    const start = safeOffset * charsPerToken;
    const end = Math.min(text.length, start + safeLimit * charsPerToken);
    const totalTokens = fallbackEstimateTokens(text);
    const hasMore = end < text.length;
    return {
      content: text.slice(start, end),
      totalTokens,
      endOffset: Math.ceil(end / charsPerToken),
      nextOffset: hasMore ? Math.ceil(end / charsPerToken) : null,
      hasMore,
    };
  }
}

function fallbackEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
