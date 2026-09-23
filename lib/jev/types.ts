export type JevQuestion = {
  type: "choice" | "score" | "noul";
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: unknown;
};

export type JevConfigView = {
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  modelId: string;
  lastTestedAt?: string;
  lastTestStatus?: "ok" | "error";
  lastTestLatencyMs?: number;
  updatedAt?: string;
};

export type ResolvedJevConfig = JevConfigView & {
  userId: string;
  apiKey: string;
};

export type JevResponse = {
  model: string;
  answers: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
};
