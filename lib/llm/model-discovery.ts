import { assertPublicProviderUrl, createSafeProviderFetch } from "./url-safety";

export type DiscoveredLlmModel = {
  id: string;
  ownedBy?: string;
};

type ModelCandidate = {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  ownedBy?: unknown;
};

export function normalizeDiscoveredModels(payload: unknown): DiscoveredLlmModel[] {
  const container = payload as { data?: unknown; models?: unknown } | null;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : null;
  if (!items) throw new Error("Provider 响应不是兼容的模型列表格式");

  const byId = new Map<string, DiscoveredLlmModel>();
  for (const item of items) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id) byId.set(id, { id });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as ModelCandidate;
    const rawId = typeof candidate.id === "string"
      ? candidate.id
      : typeof candidate.name === "string"
        ? candidate.name
        : "";
    const id = rawId.trim();
    if (!id) continue;
    const rawOwner = typeof candidate.owned_by === "string"
      ? candidate.owned_by
      : typeof candidate.ownedBy === "string"
        ? candidate.ownedBy
        : undefined;
    byId.set(id, {
      id,
      ...(rawOwner?.trim() ? { ownedBy: rawOwner.trim() } : {}),
    });
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.id.localeCompare(right.id, "en"));
}

function modelsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export async function discoverOpenAICompatibleModels(input: {
  baseUrl: string;
  apiKey: string;
}) {
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > 4_000) throw new Error("API Key 不能为空或过长");
  const response = await createSafeProviderFetch(baseUrl, 20_000)(modelsUrl(baseUrl), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
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
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 5 * 1024 * 1024) throw new Error("Provider 模型列表响应过大");
  const payload = await response.json().catch(() => {
    throw new Error("Provider 模型列表不是有效 JSON");
  });
  return normalizeDiscoveredModels(payload);
}

