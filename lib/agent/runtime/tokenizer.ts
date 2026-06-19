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

function fallbackEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
