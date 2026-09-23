import { createSafeProviderFetch, assertPublicProviderUrl } from "@/lib/llm/url-safety";
import type { JevQuestion, JevResponse, ResolvedJevConfig } from "./types";

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/systemone`;
}

export async function evaluateWithJev(input: {
  config: Pick<ResolvedJevConfig, "baseUrl" | "apiKey" | "modelId">;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  signal?: AbortSignal;
}): Promise<JevResponse> {
  const baseUrl = await assertPublicProviderUrl(input.config.baseUrl);
  const response = await createSafeProviderFetch(baseUrl, 30_000)(endpoint(baseUrl), {
    method: "POST",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      state: input.state,
      model: input.config.modelId,
      questions: input.questions,
    }),
  });
  const payload = await response.json().catch(() => null) as (JevResponse & { error?: unknown }) | null;
  if (!response.ok) {
    const error = typeof payload?.error === "string"
      ? payload.error
      : payload?.error && typeof payload.error === "object" && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message)
        : `Provider 返回 HTTP ${response.status}`;
    throw new Error(`Jev ${response.status}: ${error}`);
  }
  if (!payload || typeof payload !== "object" || !payload.answers || typeof payload.answers !== "object") {
    throw new Error("Jev 响应不是兼容的 systemone 格式");
  }
  return payload as JevResponse;
}

export async function testJevConnection(config: Pick<ResolvedJevConfig, "baseUrl" | "apiKey" | "modelId">) {
  const startedAt = Date.now();
  const response = await evaluateWithJev({
    config,
    state: "Reply only through the structured answer.",
    questions: {
      health: { type: "noul", instructions: "Is this a connection test?" },
    },
  });
  if (!response.answers.health || typeof response.answers.health !== "object") {
    throw new Error("Jev 响应缺少 health answer");
  }
  return { ok: true as const, latencyMs: Date.now() - startedAt, modelId: config.modelId };
}
