import { createSafeProviderFetch } from "./url-safety";
import type { ResolvedUserLlmModel } from "./types";

function completionUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export async function testUserLlmConnection(model: ResolvedUserLlmModel) {
  const startedAt = Date.now();
  const response = await createSafeProviderFetch(model.baseUrl, 20_000)(
    completionUrl(model.baseUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { message?: string } | string;
      message?: string;
    } | null;
    const providerMessage = typeof payload?.error === "string"
      ? payload.error
      : payload?.error?.message ?? payload?.message;
    throw new Error(
      providerMessage
        ? `Provider 返回 ${response.status}: ${providerMessage.slice(0, 300)}`
        : `Provider 返回 HTTP ${response.status}`,
    );
  }
  const payload = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  if (!Array.isArray(payload?.choices)) throw new Error("Provider 响应不是兼容的 Chat Completions 格式");
  return {
    ok: true as const,
    latencyMs: Date.now() - startedAt,
    modelId: model.modelId,
  };
}

