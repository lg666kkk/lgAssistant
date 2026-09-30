import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), connect: vi.fn(), setTimeout: vi.fn(), kill: vi.fn(),
  get: vi.fn(), setex: vi.fn(), del: vi.fn(), getE2BApiKey: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: { create: mocks.create, connect: mocks.connect, setTimeout: mocks.setTimeout, kill: mocks.kill },
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
  CommandExitError: class CommandExitError extends Error {},
}));
vi.mock("@/lib/platform/redis", () => ({
  createRedisClient: () => ({ get: mocks.get, setex: mocks.setex, del: mocks.del }),
}));
vi.mock("./config", () => ({ getE2BApiKey: mocks.getE2BApiKey }));

import { deleteChatTerminalSession, runChatTerminalCommand } from "./chat-terminal";

describe("chat terminal sandbox", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getE2BApiKey.mockResolvedValue("test-key");
    mocks.setex.mockResolvedValue("OK");
  });

  it("creates an internet-enabled sandbox and reuses it for the next command", async () => {
    let storedId: string | null = null;
    mocks.get.mockImplementation(async () => storedId);
    mocks.setex.mockImplementation(async (_key, _ttl, id) => { storedId = id; });
    const commands = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "found\n", stderr: "" }) };
    const sandbox = { sandboxId: "sandbox-1", files: { makeDir: vi.fn().mockResolvedValue(true) }, commands };
    mocks.create.mockResolvedValue(sandbox);
    mocks.connect.mockResolvedValue(sandbox);
    mocks.setTimeout.mockResolvedValue(undefined);

    const input = { userId: "user-1", scopeId: "chat-1", command: "npx skills find finance" };
    expect((await runChatTerminalCommand(input)).stdout).toBe("found\n");
    await runChatTerminalCommand({ ...input, command: "pwd" });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith("base", expect.objectContaining({ apiKey: "test-key", allowInternetAccess: true }));
    expect(commands.run).toHaveBeenCalledWith(expect.stringContaining("npm install --prefix"), expect.any(Object));
    expect(mocks.connect).toHaveBeenCalledWith("sandbox-1", { apiKey: "test-key" });
    expect(commands.run).toHaveBeenCalledWith(
      "export PATH=/home/user/.chat-terminal/node_modules/.bin:/home/user/.chat-terminal/node_modules/node/bin:$PATH; pwd",
      expect.objectContaining({ cwd: "/home/user/workspace" }),
    );
  });

  it("rejects invalid commands before creating a sandbox", async () => {
    await expect(runChatTerminalCommand({ userId: "user-1", scopeId: "chat-1", command: "\0" }))
      .rejects.toThrow("命令必须");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("destroys the sandbox when its chat is deleted", async () => {
    mocks.get.mockResolvedValue("sandbox-1");
    mocks.kill.mockResolvedValue(true);
    await deleteChatTerminalSession({ userId: "user-1", scopeId: "chat-1" });
    expect(mocks.kill).toHaveBeenCalledWith("sandbox-1", expect.objectContaining({ apiKey: "test-key" }));
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });
});
