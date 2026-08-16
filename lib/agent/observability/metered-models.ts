export type MeteredModelCategory = "embedding" | "rerank";

export type MeteredModelOption = {
  id: string;
  name: string;
  category: MeteredModelCategory;
  inputCnyPerMillionTokens: number;
};

/**
 * 百炼公开价格，统计页只做本地估算，不替代供应商账单。
 * https://help.aliyun.com/zh/model-studio/model-pricing
 */
export const meteredModelOptions: MeteredModelOption[] = [
  {
    id: "text-embedding-v4",
    name: "Qwen Text Embedding V4",
    category: "embedding",
    inputCnyPerMillionTokens: 0.5,
  },
  {
    id: "qwen3-rerank",
    name: "Qwen3 Rerank",
    category: "rerank",
    inputCnyPerMillionTokens: 0.5,
  },
];

export function getMeteredModelOption(model: string) {
  return meteredModelOptions.find((option) => option.id === model);
}

export function calculateMeteredInputCost(
  model: string,
  input: { billedInputTokens?: number; cachedInputTokens?: number },
) {
  const pricing = getMeteredModelOption(model)?.inputCnyPerMillionTokens ?? 0;
  const billedInputTokens = Math.max(0, input.billedInputTokens ?? 0);
  const cachedInputTokens = Math.max(0, input.cachedInputTokens ?? 0);
  return {
    estimatedCostCny: (billedInputTokens / 1_000_000) * pricing,
    cacheSavedCostCny: (cachedInputTokens / 1_000_000) * pricing,
  };
}
