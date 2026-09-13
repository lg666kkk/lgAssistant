import { describe, expect, it, vi } from "vitest";
import { openExternalToolSession } from "./session";

describe("external tool session ownership", () => {
  it("closes once on request abort, explicit close and response cancellation", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const session = await openExternalToolSession({
      userId: "alice", signal: controller.signal,
      port: { open: async () => ({ tools: [], close }) },
    });
    controller.abort();
    session.abort();
    await session.close();
    expect(session.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cleans up a session that finishes opening after cancellation", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const opening = openExternalToolSession({
      userId: "alice", signal: controller.signal,
      port: { open: async () => { controller.abort(); return { tools: [], close }; } },
    });
    await expect(opening).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
