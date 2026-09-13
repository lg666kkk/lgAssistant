import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn(), discover: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireUser: mocks.auth }));
vi.mock("@repo/infrastructure/mcp/user-config", () => ({ listMcpServers: mocks.list, saveMcpServer: mocks.save, deleteMcpServer: mocks.remove, discoverUserMcpTools: mocks.discover }));
import { GET, POST } from "@/app/api/mcp/servers/route";
import { PATCH, DELETE } from "@/app/api/mcp/servers/[id]/route";
import { POST as DISCOVER } from "@/app/api/mcp/discover/route";
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: "alice" }); });
describe("MCP authenticated routes", () => {
  it("does not access configuration or networks without authentication", async () => {
    mocks.auth.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const req = new Request("https://app.test/api/mcp/servers");
    for (const response of [await GET(req), await POST(req), await PATCH(req, { params: { id: "id" } }), await DELETE(req, { params: { id: "id" } }), await DISCOVER(req)]) expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.discover).not.toHaveBeenCalled();
  });
  it("uses the authenticated user instead of a submitted user ID", async () => {
    mocks.save.mockResolvedValue({ id: "server" });
    const req = new Request("https://app.test/api/mcp/servers", { method: "POST", body: JSON.stringify({ userId: "bob" }) });
    expect((await POST(req)).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith("alice", { userId: "bob" });
  });
  it("returns a recoverable validation error for malformed JSON", async () => {
    const req = new Request("https://app.test/api/mcp/servers", { method: "POST", body: "{" });
    expect((await POST(req)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
