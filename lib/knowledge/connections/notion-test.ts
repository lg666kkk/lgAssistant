export async function testNotionConnection(token: string) {
  const startedAt = Date.now();
  const response = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Notion-Version": "2022-06-28",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Notion 返回了不允许的重定向");
  }
  const payload = await response.json().catch(() => null) as {
    name?: string;
    type?: string;
    message?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    const detail = payload?.message ?? payload?.code;
    throw new Error(detail
      ? `Notion 返回 ${response.status}: ${detail.slice(0, 300)}`
      : `Notion 返回 HTTP ${response.status}`);
  }
  return {
    ok: true as const,
    latencyMs: Date.now() - startedAt,
    integrationName: payload?.name ?? "Notion Integration",
    integrationType: payload?.type,
  };
}
