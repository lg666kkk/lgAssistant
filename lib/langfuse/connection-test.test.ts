import { afterEach, describe, expect, it, vi } from "vitest";
import { testLangfuseConnection } from "./connection-test";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("testLangfuseConnection", () => {
  it("uses Basic auth and returns latency", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "project-1" }],
    }), { status: 200 })));

    const result = await testLangfuseConnection({
      baseUrl: "https://8.8.8.8",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
    });

    expect(result).toMatchObject({ ok: true, projectCount: 1 });
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(options?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    });
  });
});
