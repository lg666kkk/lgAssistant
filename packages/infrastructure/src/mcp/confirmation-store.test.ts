import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConfirmationStore } from "./confirmation-store";
import type { Continuation } from "@repo/application/mcp/continuation";
// No production key or Redis database is used by this isolated integration fixture.
vi.mock("@/lib/runtime-config/service", () => ({
  encryptRuntimeConfigValue: (s: string) => Buffer.from(s).toString("base64"),
  decryptRuntimeConfigValue: (s: string) => Buffer.from(s, "base64").toString(),
}));
let proc: ChildProcess, redis: Redis, folder: string;
beforeAll(async () => {
  folder = await mkdtemp("/tmp/mcp-confirmation-");
  const socket = join(folder, "redis.sock");
  proc = spawn(
    "redis-server",
    ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    },
  );
  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) =>
      reject(new Error(`Redis fixture exited: ${code}`)),
    );
    proc.stdout!.on("data", (data) => {
      if (
        String(data).includes("ready to accept connections") ||
        String(data).includes("Ready to accept connections")
      )
        resolve();
    });
  });
  redis = new Redis(socket);
  await redis.ping();
});
afterAll(async () => {
  await redis?.quit();
  proc?.kill();
  if (folder) await rm(folder, { recursive: true, force: true });
});
describe("atomic confirmation store", () => {
  it("allows only one concurrent claimant, isolates users, and returns the cached response after reconnect", async () => {
    const first = createConfirmationStore(redis),
      second = createConfirmationStore(redis);
    const state = { sessionId: "s", pending: [{ id: "c" }] } as Continuation;
    const token = await first.create("alice", state);
    await expect(second.claim("bob", token, "c")).rejects.toThrow("过期");
    const attempts = await Promise.allSettled([
      first.claim("alice", token, "c"),
      second.claim("alice", token, "c"),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const response = { events: [], pending: false };
    await first.save("alice", token, state, "c", response);
    expect((await second.claim("alice", token, "c")).response).toEqual(
      response,
    );
    await second.release("alice", token);
  });
  it("never automatically releases an ambiguous in-flight execution", async () => {
    const store = createConfirmationStore(redis);
    const token = await store.create("alice", {} as Continuation);
    await store.claim("alice", token, "call");
    await expect(
      createConfirmationStore(redis).claim("alice", token, "call"),
    ).rejects.toThrow("状态未知");
    expect(
      JSON.parse((await redis.get(`tool-confirmation:alice:${token}`))!).busy,
    ).toBe(true);
    expect(await redis.ttl(`tool-confirmation:alice:${token}`)).toBeGreaterThan(
      7000,
    );
    await store.release("alice", token);
  });
});
