import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn(() => "stored-secret"),
  publicUrl: vi.fn(async (url: string) => url),
  connect: vi.fn(),
}));
vi.mock("@/lib/platform/supabase", () => ({
  getSupabase: () => ({ from: mocks.from }),
}));
vi.mock("@/lib/runtime-config/service", () => ({
  encryptRuntimeConfigValue: mocks.encrypt,
  decryptRuntimeConfigValue: mocks.decrypt,
}));
vi.mock("@/lib/llm/url-safety", () => ({
  assertPublicProviderUrl: mocks.publicUrl,
}));
vi.mock("./client", () => ({
  connectMcpServer: mocks.connect,
}));
import {
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
  discoverUserMcpTools,
  parseMcpDraft,
  createManagedMcpToolsPort,
} from "./user-config";
const id = "11111111-1111-4111-8111-111111111111";
const existing = {
  id,
  name: "Service",
  url: "https://example.com/mcp",
  enabled: true,
  token_ciphertext: "encrypted-value",
  tools: [
    { name: "lookup", description: "", enabled: true, approval: "always" },
  ],
  updated_at: "2026-09-13",
};
const draft = {
  name: "Service",
  url: existing.url,
  enabled: true,
  tools: existing.tools,
};
function query(data: unknown, error: unknown = null) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "order", "update", "insert", "delete"])
    q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => ({ data, error }));
  q.single = vi.fn(async () => ({ data, error }));
  q.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error }).then(resolve);
  mocks.from.mockReturnValueOnce(q);
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset();
});

describe("user MCP configuration", () => {
  it("does not connect when the user has no enabled services", async () => {
    query([{ ...existing, enabled: false }]);
    const session = await createManagedMcpToolsPort().open({ userId: "alice", signal: new AbortController().signal });
    expect(session.tools).toEqual([]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("returns metadata without ciphertext or plaintext", async () => {
    const q = query([existing]);
    const result = await listMcpServers("alice");
    expect(q.eq).toHaveBeenCalledWith("user_id", "alice");
    expect(result.servers[0].tokenConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("encrypted-value");
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("reports missing migration separately from an empty list", async () => {
    query(null, { code: "42P01" });
    expect((await listMcpServers("alice")).storageReady).toBe(false);
  });
  it("scopes updates to the user and preserves an existing secret when blank", async () => {
    const read = query(existing);
    const write = query(existing);
    await saveMcpServer("alice", draft, id);
    expect(read.eq).toHaveBeenCalledWith("user_id", "alice");
    expect(write.eq).toHaveBeenCalledWith("user_id", "alice");
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({ token_ciphertext: "encrypted:stored-secret" }),
    );
  });
  it("refuses to forward a saved token to a changed endpoint", async () => {
    query(existing);
    await expect(
      discoverUserMcpTools(
        "alice",
        { id, url: "https://another.example/mcp" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("重新填写 Token");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("clears a token explicitly", async () => {
    query(existing);
    const write = query(existing);
    await saveMcpServer("alice", { ...draft, clearToken: true }, id);
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({ token_ciphertext: "" }),
    );
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("rejects cross-user access before secret reads or deletion", async () => {
    const read = query(null);
    await expect(deleteMcpServer("bob", id)).rejects.toThrow("无权访问");
    expect(read.eq).toHaveBeenCalledWith("user_id", "bob");
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("only discovers tools and closes the session", async () => {
    const close = vi.fn();
    mocks.connect.mockResolvedValue({
      discoveredTools: [{ name: "lookup", description: "Read records" }],
      tools: [],
      close,
    });
    const result = await discoverUserMcpTools(
      "alice",
      { url: existing.url, token: "new-secret" },
      new AbortController().signal,
    );
    expect(result.tools).toEqual([
      { name: "lookup", description: "Read records" },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] }),
      expect.objectContaining({ userId: "alice" }),
      "new-secret",
    );
  });
  it("loads only enabled user tools into the chat runtime", async () => {
    query([
      {
        ...existing,
        tools: [
          ...existing.tools,
          { name: "disabled", enabled: false, approval: "always" },
        ],
      },
    ]);
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ tools: [{ name: "remote" }], close });
    const session = await createManagedMcpToolsPort().open({
      userId: "alice",
      signal: new AbortController().signal,
    });
    expect(mocks.connect.mock.calls[0][0].tools).toEqual([
      {
        name: "lookup",
        riskLevel: "confirm",
        sideEffect: "external",
        timeoutSeconds: 30,
      },
    ]);
    expect(session.tools).toHaveLength(1);
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid policy and excessive enabled tools", () => {
    expect(() => parseMcpDraft({ ...draft, tools: [] })).toThrow("至少允许");
    expect(() =>
      parseMcpDraft({
        ...draft,
        tools: Array.from({ length: 33 }, (_, i) => ({
          ...existing.tools[0],
          name: `tool${i}`,
        })),
      }),
    ).toThrow("32");
    expect(() =>
      parseMcpDraft({
        ...draft,
        tools: [{ ...existing.tools[0], approval: "auto" }],
      }),
    ).toThrow("格式");
  });
});
