import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), resolve: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("./channels/config", () => ({ resolveNotificationChannel: mocks.resolve }));
vi.mock("./channels/providers", () => ({ sendNotification: mocks.send }));
import { deliverDueNotifications } from "./deliveries";

let row: Record<string, any>;
let updates: Record<string, unknown>[];
let failAcknowledgement: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: "delivery-1", run_id: 1, job_id: "job-1", user_id: "user-1", provider: "telegram",
    status: "sending", text: "message", attempt_count: 1, max_attempts: 5,
    next_attempt_at: Date.now(), lease_owner: "worker-1", lease_until: Date.now() + 60_000,
  };
  updates = [];
  failAcknowledgement = false;
  mocks.rpc.mockResolvedValueOnce({ data: [{ ...row }], error: null }).mockResolvedValue({ data: [], error: null });
  mocks.resolve.mockResolvedValue({ provider: "telegram" });
  mocks.send.mockImplementation(async (_channel, _text, beforeSend) => {
    await beforeSend();
    return { messageId: "sent-1" };
  });
  mocks.from.mockImplementation(() => {
    let patch: Record<string, unknown> = {};
    const filters: Array<() => boolean> = [];
    const commit = () => {
      if (patch.status === "delivered" && failAcknowledgement) return { data: null, error: { message: "database unavailable" } };
      if (!filters.every((check) => check())) return { data: null, error: null };
      updates.push(patch);
      Object.assign(row, patch);
      return { data: { id: row.id }, error: null };
    };
    const query = {
      update(value: Record<string, unknown>) { patch = value; return query; },
      eq(key: string, value: unknown) { filters.push(() => row[key] === value); return query; },
      gt(key: string, value: number) { filters.push(() => row[key] > value); return query; },
      select() { return query; },
      maybeSingle: async () => commit(),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(commit()).then(resolve); },
    };
    return query;
  });
});

describe("notification delivery ownership", () => {
  it("claims only one message at a time and acknowledges a successful send", async () => {
    expect(await deliverDueNotifications({ workerId: "worker-1" })).toMatchObject({ due: 1, delivered: 1, failed: 0 });
    expect(mocks.rpc.mock.calls.every((call) => call[1].p_limit === 1)).toBe(true);
    expect(row).toMatchObject({ status: "delivered", provider_message_id: "sent-1" });
  });

  it("does not send after another attempt takes ownership", async () => {
    const transport = vi.fn();
    mocks.resolve.mockImplementation(async () => {
      row.attempt_count = 2;
      return { provider: "telegram" };
    });
    mocks.send.mockImplementation(async (_channel, _text, beforeSend) => {
      await beforeSend();
      transport();
      return {};
    });
    expect(await deliverDueNotifications({ workerId: "worker-1" })).toMatchObject({ failed: 1, delivered: 0 });
    expect(transport).not.toHaveBeenCalled();
    expect(row.status).toBe("sending");
    expect(updates).toEqual([]);
  });

  it("does not acknowledge a newer attempt even if the worker id is reused", async () => {
    mocks.send.mockImplementation(async (_channel, _text, beforeSend) => {
      await beforeSend();
      row.attempt_count = 2;
      return { messageId: "old-send" };
    });
    expect(await deliverDueNotifications({ workerId: "worker-1" })).toMatchObject({ delivered: 0, failed: 1 });
    expect(row.status).toBe("sending");
    expect(row.provider_message_id).toBeUndefined();
  });

  it("does not turn acknowledgement failures into immediate send retries", async () => {
    failAcknowledgement = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deliverDueNotifications({ workerId: "worker-1" })).toMatchObject({ failed: 1 });
      expect(row.status).toBe("sending");
      expect(updates.some((patch) => patch.status === "retry_wait")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
