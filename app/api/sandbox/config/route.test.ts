import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getUserSandboxConfigView: vi.fn(),
  saveUserSandboxConfig: vi.fn(),
  getE2BApiKey: vi.fn(),
  recordSandboxConnectionTest: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/sandbox/config", () => ({
  getUserSandboxConfigView: mocks.getUserSandboxConfigView,
  saveUserSandboxConfig: mocks.saveUserSandboxConfig,
  getE2BApiKey: mocks.getE2BApiKey,
  recordSandboxConnectionTest: mocks.recordSandboxConnectionTest,
}));
vi.mock("e2b", () => ({ Sandbox: { list: mocks.list } }));

import { GET, PATCH } from "./route";
import { POST } from "../test/route";

describe("sandbox configuration routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getUserSandboxConfigView.mockResolvedValue({ configured: true, hint: "••••1234", source: "user" });
    mocks.getE2BApiKey.mockResolvedValue("user-1-secret");
    mocks.recordSandboxConnectionTest.mockResolvedValue(undefined);
    mocks.list.mockReturnValue({ nextItems: vi.fn().mockResolvedValue([]) });
  });

  it("lets a signed-in user save and test their own key", async () => {
    const response = await PATCH(new Request("http://localhost/api/sandbox/config", {
      method: "PATCH", body: JSON.stringify({ apiKey: "new-secret" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.saveUserSandboxConfig).toHaveBeenCalledWith({ userId: "user-1", apiKey: "new-secret" });

    const testResponse = await POST(new Request("http://localhost/api/sandbox/test", { method: "POST" }));
    expect(testResponse.status).toBe(200);
    expect(mocks.getE2BApiKey).toHaveBeenCalledWith("user-1");
    expect(mocks.list).toHaveBeenCalledWith({ apiKey: "user-1-secret", limit: 1 });
  });

  it("never returns plaintext to the browser", async () => {
    const response = await GET(new Request("http://localhost/api/sandbox/config"));
    expect(await response.json()).toEqual({ configured: true, hint: "••••1234", source: "user" });
  });

  it("requires login", async () => {
    mocks.requireUser.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET(new Request("http://localhost/api/sandbox/config"))).status).toBe(401);
  });
});
