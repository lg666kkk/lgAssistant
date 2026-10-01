import { afterEach, describe, expect, it, vi } from "vitest";
import { withChatSessionLease } from "./session-lease";
const request = (sessionId = "session-1", signal?: AbortSignal) => new Request("https://app.test/api/chat", {
  method: "POST", body: JSON.stringify({ sessionId }), signal,
});
function database() {
  const locks = new Map<string, string>();
  return {
    locks,
    set: vi.fn(async (key: string, owner: string) => {
      if (locks.has(key)) return null;
      locks.set(key, owner); return "OK";
    }),
    eval: vi.fn(async (script: string, _count: number, key: string, owner: string) => {
      if (locks.get(key) !== owner) return 0;
      if (script.includes("DEL")) locks.delete(key);
      return 1;
    }),
  };
}
afterEach(() => vi.useRealTimers());
describe("chat session lease", () => {
  it("holds the lock until the response stream finishes", async () => {
    const db = database();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const handler = vi.fn(async () => new Response(new ReadableStream({ start(controller) { output = controller; } })));
    const response = await withChatSessionLease(request(), "user-1", handler, db as any);
    expect((await withChatSessionLease(request(), "user-1", handler, db as any)).status).toBe(409);
    expect(handler).toHaveBeenCalledTimes(1);
    output.enqueue(new TextEncoder().encode("answer")); output.close();
    expect(await response.text()).toBe("answer");
    expect(db.locks.size).toBe(0);
    const next = await withChatSessionLease(request(), "user-1", async () => new Response("next"), db as any);
    expect(await next.text()).toBe("next");
  });
  it("isolates locks by user and session", async () => {
    const db = database();
    const handler = async () => new Response("answer");
    const responses = await Promise.all([
      withChatSessionLease(request(), "user-1", handler, db as any),
      withChatSessionLease(request(), "user-2", handler, db as any),
      withChatSessionLease(request("session-2"), "user-1", handler, db as any),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
  });
  it("releases ownership when the handler fails", async () => {
    const db = database();
    await expect(withChatSessionLease(request(), "user-1", async () => { throw new Error("failed"); }, db as any)).rejects.toThrow("failed");
    expect(db.locks.size).toBe(0);
  });
  it("fails closed when the lock store is unavailable", async () => {
    const db = database(); db.set.mockRejectedValue(new Error("unavailable"));
    const handler = vi.fn();
    expect((await withChatSessionLease(request(), "user-1", handler, db as any)).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
  it("cancels the upstream stream and releases the lock on disconnect", async () => {
    const db = database(); const cancel = vi.fn();
    const response = await withChatSessionLease(request(), "user-1", async () => new Response(new ReadableStream({ cancel })), db as any);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalled(); expect(db.locks.size).toBe(0);
  });
  it("renews a slow request and aborts if its lease is lost", async () => {
    vi.useFakeTimers();
    const db = database(); const cancel = vi.fn();
    let signal!: AbortSignal;
    const response = await withChatSessionLease(request(), "user-1", async (req) => {
      signal = req.signal; return new Response(new ReadableStream({ cancel }));
    }, db as any);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(db.eval).toHaveBeenCalledWith(expect.stringContaining("PEXPIRE"), 1, expect.any(String), expect.any(String), 90_000);
    db.locks.clear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal.aborted).toBe(true); expect(cancel).toHaveBeenCalled();
    await response.body!.cancel().catch(() => {});
  });
});
