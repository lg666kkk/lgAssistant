import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "./cron-auth";

function request(headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/cron/tick", { headers });
}

describe("cron request authorization", () => {
  it("rejects a spoofed Vercel cron user-agent when a secret is configured", () => {
    expect(isAuthorizedCronRequest(
      request({ "user-agent": "vercel-cron/1.0" }),
      { cronSecret: "expected", nodeEnv: "production" },
    )).toBe(false);
  });

  it("accepts Vercel bearer auth and the explicit cron header", () => {
    const environment = { cronSecret: "expected", nodeEnv: "production" };
    expect(isAuthorizedCronRequest(
      request({ authorization: "Bearer expected" }),
      environment,
    )).toBe(true);
    expect(isAuthorizedCronRequest(
      request({ "x-cron-secret": "expected" }),
      environment,
    )).toBe(true);
  });

  it("does not allow development headers to bypass a configured secret", () => {
    expect(isAuthorizedCronRequest(
      request({ "x-scheduler-dev": "1", "x-cron-secret": "wrong" }),
      { cronSecret: "expected", nodeEnv: "development" },
    )).toBe(false);
  });

  it("allows the development scheduler only outside production without a secret", () => {
    expect(isAuthorizedCronRequest(
      request({ "x-scheduler-dev": "1" }),
      { nodeEnv: "development" },
    )).toBe(true);
    expect(isAuthorizedCronRequest(
      request({ "x-scheduler-dev": "1" }),
      { nodeEnv: "production" },
    )).toBe(false);
  });
});
