import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "./builtin";
import { runTerminalCommandTool, terminalCommandIsForbidden, terminalCommandRequiresConfirmation } from "./terminal-command";
import { executeToolCall } from "./tool-router";
import { requiresCitedEvidence } from "./grounding-policy";

describe("tool grounding policy", () => {
  it("derives citation requirements from actual tool output policies", () => {
    expect(requiresCitedEvidence({
      toolEvidenceRequired: false,
    })).toBe(false);
    expect(requiresCitedEvidence({
      toolEvidenceRequired: true,
    })).toBe(true);
    expect(requiresCitedEvidence({
      sourceEvidenceRequired: true,
      toolEvidenceRequired: false,
    })).toBe(true);
  });

  it("registers capabilities and output policies for every builtin tool", () => {
    const registry = createBuiltinToolRegistry();

    for (const tool of registry.list()) {
      expect(tool.capabilities.length, tool.name).toBeGreaterThan(0);
      expect(tool.outputPolicy.grounding, tool.name).toBeTruthy();
    }
    expect(registry.toolsForCapability("time.current").map((tool) => tool.name))
      .toEqual(["get_current_time"]);
    expect(registry.listForModel().find((tool) => tool.name === "get_current_time")?.description)
      .toContain("time.current");
    expect(registry.groundingModesFor(["get_current_time", "web_search"]))
      .toEqual(new Set(["authoritative_result", "cited_evidence"]));
  });

  it("allows known Skill lookups without model classification", async () => {
    const registry = createBuiltinToolRegistry();
    expect(await terminalCommandRequiresConfirmation({ command: "npx skills find finance" })).toBe(false);
    expect(await terminalCommandRequiresConfirmation({ command: 'npx -y skills find "image generation" 2>&1 | tail -40' })).toBe(false);
    expect(registry.get("run_terminal_command")?.runtime.sandboxed).toBe(true);
    expect(registry.get("web_search")?.riskLevel).toBe("safe");
    expect(registry.get("web_search")?.runtime.requiresConfirmation).toBe(false);
  });

  it.each([
    "npm install",
    "cat package.json",
    "pwd && cat /etc/passwd",
    "git status > /tmp/status",
    "npx skills add owner/repo",
    'npx -y skills find "image generation" 2>&1 | tail -40; pwd',
  ])("keeps confirmation for unsafe terminal command: %s", async (command) => {
    expect(await terminalCommandRequiresConfirmation({ command })).toBe(true);
  });

  it.each(["rm -rf /tmp/test", "rmdir /tmp/test", "sudo apt install x", "dd if=/dev/zero of=/tmp/x"])(
    "blocks forbidden terminal command without confirmation: %s",
    async (command) => {
      expect(terminalCommandIsForbidden({ command })).toBe(true);
      expect(await terminalCommandRequiresConfirmation({ command })).toBe(false);
      const result = await runTerminalCommandTool.execute({ command }, { userId: "user-1", scopeId: "chat-1" });
      expect(result.metadata).toMatchObject({ status: "blocked", reason: "forbidden_command" });
    },
  );
});
