import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), getSupabase: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: mocks.getSupabase, hasSupabaseConfig: () => true }));

beforeEach(() => vi.clearAllMocks());

describe("trace detail request isolation", () => {
  it.each(["root", "continuation"])("only merges the confirmation chain when selecting %s", async (selectedId) => {
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    const root = {
      id: "root", request_id: "request-root", session_id: "session-1", created_at: "2026-09-30T01:00:00Z",
      stop_reason: "awaiting_tool_confirmation", completed: false, total_duration_ms: 100,
      steps: [{ type: "model", index: 0 }], metrics: { modelCallCount: 1, toolCallCount: 0, toolDurations: [] },
    };
    const continuation = {
      ...root, id: "continuation", request_id: "request-continuation", created_at: "2026-09-30T01:01:00Z",
      stop_reason: "completed", completed: true, total_duration_ms: 200,
      steps: [{ type: "tool", index: 0, metadata: { parentRequestId: "request-root" } }],
      metrics: { modelCallCount: 0, toolCallCount: 1, toolDurations: [{ name: "run_terminal_command", durationMs: 50 }] },
    };
    const unrelated = {
      ...root, id: "other", request_id: "request-other", created_at: "2026-09-30T01:02:00Z",
      stop_reason: "error", metrics: { modelCallCount: 99 },
    };
    const selected = selectedId === "root" ? root : continuation;
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: selected, error: null }),
      order: vi.fn().mockResolvedValue({ data: [root, continuation, unrelated], error: null }),
    };
    mocks.getSupabase.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
    const response = await GET(new Request("http://localhost/api/traces/" + selectedId), { params: { id: selectedId } });
    expect(response.status).toBe(200);
    expect((await response.json()).trace).toMatchObject({
      id: selectedId, request_id: selected.request_id, stop_reason: "completed", completed: true,
      total_duration_ms: 300, steps: [{ type: "model", index: 0 }, { type: "tool", index: 1 }],
      metrics: { modelCallCount: 1, toolCallCount: 1, toolDurations: [{ name: "run_terminal_command", durationMs: 50 }] },
    });
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(query.eq).toHaveBeenCalledWith("session_id", "session-1");
  });
});
