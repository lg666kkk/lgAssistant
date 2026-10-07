import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "./route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), clear: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/knowledge/connections/notion-config", () => ({
  clearUserNotionConnection: mocks.clear,
  getUserNotionConnection: vi.fn(),
  updateUserNotionConnection: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "current-user" });
});

describe("clear Notion connection", () => {
  it("requires authentication before clearing data", async () => {
    mocks.user.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const response = await DELETE(new Request("http://localhost/api/knowledge/connections/notion", { method: "DELETE" }));
    expect(response.status).toBe(401);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("uses the authenticated user even when another user is supplied", async () => {
    const result = { config: { enabled: false, tokenConfigured: false }, counts: { pages: 2 } };
    mocks.clear.mockResolvedValue(result);
    const response = await DELETE(new Request("http://localhost/api/knowledge/connections/notion?userId=other", {
      method: "DELETE", body: JSON.stringify({ userId: "other" }),
    }));
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith("current-user");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
  });

  it("reports a failed transaction without claiming success", async () => {
    mocks.clear.mockRejectedValue(new Error("清除 Notion 数据失败"));
    const response = await DELETE(new Request("http://localhost/api/knowledge/connections/notion", { method: "DELETE" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "清除 Notion 数据失败" });
  });
});
