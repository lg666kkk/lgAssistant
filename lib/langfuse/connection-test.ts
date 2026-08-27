import { assertPublicProviderUrl } from "@/lib/llm/url-safety";

export async function testLangfuseConnection(input: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}) {
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const publicKey = input.publicKey.trim();
  const secretKey = input.secretKey.trim();
  if (!publicKey || !secretKey) throw new Error("Public Key 和 Secret Key 不能为空");
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/public/projects`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Langfuse 返回了不允许的重定向");
  }
  const payload = await response.json().catch(() => null) as {
    data?: unknown[];
    projects?: unknown[];
    message?: string;
    error?: string;
  } | null;
  if (!response.ok) {
    const detail = payload?.message ?? payload?.error;
    throw new Error(detail
      ? `Langfuse 返回 ${response.status}: ${detail.slice(0, 300)}`
      : `Langfuse 返回 HTTP ${response.status}`);
  }
  const projectCount = Array.isArray(payload?.data)
    ? payload.data.length
    : Array.isArray(payload?.projects) ? payload.projects.length : undefined;
  return {
    ok: true as const,
    latencyMs: Date.now() - startedAt,
    projectCount,
  };
}
