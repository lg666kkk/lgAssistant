import { createHmac } from "node:crypto";

export type SandboxRun = {
  runId: string;
  kind: "command" | "skill" | "coding";
  status: string;
  skillId?: string;
  skillVersion?: string;
  profileId: string;
  stdoutRef?: string;
  stderrRef?: string;
  resultRef?: string;
  result?: unknown;
  message?: string;
  createdAt: string;
  updatedAt: string;
};

export async function createSkillRun(input: {
  userId: string;
  sessionId?: string;
  toolCallId?: string;
  runId: string;
  idempotencyKey: string;
  skillId: string;
  skillVersion: string;
  skillInput: unknown;
}): Promise<SandboxRun> {
  return sandboxRequest<SandboxRun>(input.userId, "/v1/skill-runs", {
    method: "POST",
    body: JSON.stringify({
      userId: input.userId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      input: input.skillInput,
    }),
  });
}

export async function getSandboxRun(userId: string, runId: string): Promise<SandboxRun> {
  return sandboxRequest<SandboxRun>(userId, `/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" });
}

export async function cancelSandboxRun(userId: string, runId: string): Promise<void> {
  await sandboxRequest<undefined>(userId, `/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

async function sandboxRequest<T>(userId: string, requestTarget: string, init: { method: string; body?: string }): Promise<T> {
  const baseURL = process.env.SANDBOX_BROKER_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:8081");
  const secret = process.env.SANDBOX_BROKER_AUTH_SECRET ?? "";
  if (!baseURL || secret.length < 32) throw new Error("Sandbox Broker URL 或 HMAC 密钥尚未配置");
  const body = init.body ?? "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonical = `${timestamp}\n${init.method}\n${requestTarget}\n${userId}\n${body}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(new URL(requestTarget, baseURL), {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      "X-Sandbox-Timestamp": timestamp,
      "X-Sandbox-Signature": signature,
      "X-Sandbox-User-ID": userId,
    },
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Sandbox Broker 返回 ${response.status}`);
  return payload as T;
}
