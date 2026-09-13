import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireUser: mocks.auth }));
vi.mock("@repo/infrastructure/chat", () => ({
  createProductionChatDependencies: () => ({}),
}));
vi.mock("@repo/application/mcp/confirm-tool", () => ({
  confirmTool: mocks.confirm,
}));
import { POST } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: "alice" });
});
const request = (body: unknown) =>
  new Request("https://app.test/api/tools/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
describe("confirmation endpoint", () => {
  it("rejects unauthenticated and legacy parameter-only execution", async () => {
    expect(
      (await POST(request({ toolCall: { name: "create_todo", input: {} } })))
        .status,
    ).toBe(400);
    mocks.auth.mockResolvedValue(new Response("", { status: 401 }));
    expect(
      (await POST(request({ token: "t", callId: "c", action: "confirm" })))
        .status,
    ).toBe(401);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("streams tool results and the resumed answer, scoped to the authenticated user", async () => {
    mocks.confirm.mockImplementation(async (input) => {
      expect(input.userId).toBe("alice");
      expect(input).not.toHaveProperty("toolCall");
      input.onEvent({ type: "text", content: "continued" });
      return { events: [], pending: false };
    });
    const response = await POST(
      request({
        userId: "bob",
        token: "t",
        callId: "c",
        action: "confirm",
        toolCall: { input: "tampered" },
      }),
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain("continued");
    expect(body).toContain('"type":"done"');
  });
  it("surfaces checkpoint errors as SSE error events", async () => {
    mocks.confirm.mockRejectedValue(new Error("expired"));
    const response = await POST(
      request({ token: "t", callId: "c", action: "confirm" }),
    );
    expect(await response.text()).toContain('"message":"expired"');
  });
});
