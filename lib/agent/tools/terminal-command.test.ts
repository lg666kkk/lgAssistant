import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateTextWithProvider } from "@/lib/agent/runtime/model-provider";
import { runChatTerminalCommand } from "@/lib/sandbox/chat-terminal";
import { runTerminalCommandTool } from "./terminal-command";
import { ToolRegistry } from "./registry";
import { executeToolCall } from "./tool-router";

vi.mock("@/lib/agent/runtime/model-provider", () => ({ generateTextWithProvider: vi.fn() }));
vi.mock("@/lib/sandbox/chat-terminal", () => ({ runChatTerminalCommand: vi.fn() }));
const context = { userId: "user-risk", scopeId: "chat-risk", model: "deepseek-v4-pro", requestId: "request-risk" };

let caseNumber = 0;
beforeEach(() => {
  context.scopeId = `chat-risk-${++caseNumber}`;
  vi.resetAllMocks();
  vi.mocked(generateTextWithProvider).mockResolvedValue('{"decision":"require_confirmation","reason":"Cannot determine behavior"}');
  vi.mocked(runChatTerminalCommand).mockResolvedValue({
    ok: true, exitCode: 0, stdout: "done", stderr: "", sandboxId: "sandbox", reset: false, cwd: "/home/user/workspace",
  });
});

function run(command: string, approved = false) {
  const registry = new ToolRegistry();
  registry.register(runTerminalCommandTool);
  return executeToolCall(registry, { name: "run_terminal_command", input: { command } }, { ...context, approved });
}

describe("terminal confirmation classifier", () => {
  it("keeps an installation pending when the classifier requires confirmation", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue(JSON.stringify({ decision: "require_confirmation", reason: "writes files" }));
    expect(await run("npm install finance-tool")).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
    expect(generateTextWithProvider).toHaveBeenCalledWith(expect.objectContaining({
      model: context.model, telemetryMetadata: expect.objectContaining({ userId: context.userId, requestId: context.requestId }),
    }));
  });

  it("preserves a user-configured model UUID when classifying", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue('{"decision":"allow_without_confirmation","reason":"read-only"}');
    const model = "12345678-1234-4123-8123-123456789abc";
    expect(await runTerminalCommandTool.requiresConfirmationFor!({ command: "cat package.json" }, { ...context, model })).toBe(false);
    expect(generateTextWithProvider).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it("executes a read command when explicitly allowed", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue(JSON.stringify({ decision: "allow_without_confirmation", reason: "read-only" }));
    expect(await run("cat package.json")).toMatchObject({ ok: true });
    expect(runChatTerminalCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "cat package.json" }));
  });

  it.each([
    "not json", "null", '{}', '{"decision":"unknown","reason":"ok"}',
    '{"decision":"allow_without_confirmation"}',
    JSON.stringify({ decision: "allow_without_confirmation", reason: "x".repeat(301) }),
    '{"decision":"allow_without_confirmation","reason":" "}',
  ])("requires confirmation for invalid classifier output: %s", async (output) => {
    vi.mocked(generateTextWithProvider).mockResolvedValue(output);
    expect(await run("cat package.json")).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it("requires confirmation when the provider fails", async () => {
    vi.mocked(generateTextWithProvider).mockRejectedValue(new Error("unavailable"));
    expect(await run("cat package.json")).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it("requires confirmation without user configuration", async () => {
    expect(await runTerminalCommandTool.requiresConfirmationFor!({ command: "cat package.json" }, { model: context.model })).toBe(true);
    expect(generateTextWithProvider).not.toHaveBeenCalled();
  });

  it("asks the classifier to assess file redirection", async () => {
    expect(await run("echo ok > /tmp/output")).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(generateTextWithProvider).toHaveBeenCalled();
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it("classifies even simple queries without a whitelist", async () => {
    expect(await run("pwd")).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(generateTextWithProvider).toHaveBeenCalled();
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it.each([
    'npx -y skills find "poster cover design" 2>&1 | tail -30',
    "skills find 财务分析",
    "npx --yes skills find design | head -n 20",
    "npx -y skills find image generation 2>&1 | tail -60",
    'npx -y skills find "image generation" 2>&1 | tail -60',
    "npx -y skills find image generation 2>&1 | head -60",
  ])("executes Skill lookups even when the classifier is unavailable: %s", async (command) => {
    vi.mocked(generateTextWithProvider).mockRejectedValue(new Error("unavailable"));
    expect(await run(command)).toMatchObject({ ok: true });
    expect(generateTextWithProvider).not.toHaveBeenCalled();
    expect(runChatTerminalCommand).toHaveBeenCalledWith(expect.objectContaining({ command }));
  });

  it.each([
    "npx skills add owner/repo",
    "npx skills find design; touch /tmp/result",
    "npx skills find design\ntouch /tmp/result",
    "npx skills find --config /tmp/custom",
    "npx skills find design | tee /tmp/result",
    "npx -y skills find image generation 2>&1 | tail -60 > /tmp/result",
    "npx -y skills find $(touch /tmp/result) 2>&1 | tail -60",
  ])("keeps pipelines pending when the classifier cannot allow them: %s", async (command) => {
    expect(await run(command)).toMatchObject({ metadata: { status: "pending_confirmation" } });
    expect(generateTextWithProvider).toHaveBeenCalled();
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it("blocks blacklisted commands before classification", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue('{"decision":"allow_without_confirmation","reason":"allow"}');
    expect(await run("ls;/bin/rm -rf /tmp/test")).toMatchObject({ metadata: { status: "blocked" } });
    expect(generateTextWithProvider).not.toHaveBeenCalled();
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });

  it("executes approved commands without reclassifying", async () => {
    expect(await run("npm install finance-tool", true)).toMatchObject({ ok: true });
    expect(generateTextWithProvider).not.toHaveBeenCalled();
  });

  it.each(["rm -rf /tmp/test", "pwd;rm -rf /tmp/test", "pwd|/bin/rm /tmp/test", '"sudo" ls', "ls && /usr/bin/shred /tmp/test", "mkfs.ext4 /dev/test"])("still blocks forbidden commands after approval: %s", async (command) => {
    expect(await run(command, true)).toMatchObject({ metadata: { status: "blocked" } });
    expect(generateTextWithProvider).not.toHaveBeenCalled();
    expect(runChatTerminalCommand).not.toHaveBeenCalled();
  });
});
