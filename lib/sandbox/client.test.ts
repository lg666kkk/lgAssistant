import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillRun } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sandbox broker client", () => {
  it("signs method, target, user and exact body", async () => {
    process.env.SANDBOX_BROKER_URL = "http://127.0.0.1:8081";
    process.env.SANDBOX_BROKER_AUTH_SECRET = "s".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: "skill-run-1",
      kind: "skill",
      status: "queued",
      profileId: "skill-trusted",
      createdAt: "2026-09-04T00:00:00Z",
      updatedAt: "2026-09-04T00:00:00Z",
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createSkillRun({
      userId: "user-1",
      runId: "skill-run-1",
      idempotencyKey: "idem-1",
      skillId: "markdown-check",
      skillVersion: "1.0.0",
      skillInput: { markdown: "# Title" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    const timestamp = headers.get("X-Sandbox-Timestamp") ?? "";
    const body = String(init.body);
    const expected = createHmac("sha256", "s".repeat(32))
      .update(`${timestamp}\nPOST\n/v1/skill-runs\nuser-1\n${body}`)
      .digest("hex");
    expect(url.toString()).toBe("http://127.0.0.1:8081/v1/skill-runs");
    expect(headers.get("X-Sandbox-User-ID")).toBe("user-1");
    expect(headers.get("X-Sandbox-Signature")).toBe(expected);
  });
});
