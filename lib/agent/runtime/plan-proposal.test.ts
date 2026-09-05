import { describe, expect, it, vi, beforeEach } from "vitest";
import { generateTextWithProvider } from "./model-provider";
import { createPlanProposal } from "./plan-execution";
import { ToolRegistry } from "@/lib/agent/tools/registry";

vi.mock("./model-provider", () => ({ generateTextWithProvider: vi.fn() }));

const input = {
  messages: [{ role: "user" as const, content: "用技能完成项目迁移" }],
  tools: [{ name: "view_skill", description: "读取已启用的 SKILL.md", input_schema: { type: "object" as const } }],
  toolRegistry: new ToolRegistry(), maxToolIterations: 4, allToolSources: [], requestId: "proposal-1",
  subgoals: ["分析现状", "实施迁移"],
};

describe("semantic plan generation", () => {
  beforeEach(() => { vi.mocked(generateTextWithProvider).mockReset(); });

  it("plans Skill tasks when selected and includes capability descriptions", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue(JSON.stringify({ objective: "迁移项目", steps: [
      { goal: "加载迁移技能", allowedTools: ["view_skill"], successCriteria: ["已加载"] },
      { goal: "应用迁移步骤", allowedTools: [], successCriteria: ["已完成"] },
    ] }));
    const plan = await createPlanProposal(input);
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0].allowedTools).toEqual(["view_skill"]);
    expect(JSON.parse(vi.mocked(generateTextWithProvider).mock.calls[0][0].prompt)).toMatchObject({
      subgoals: input.subgoals, toolDescriptions: [{ name: "view_skill", description: "读取已启用的 SKILL.md" }],
    });
  });

  it("returns null rather than a research template when generation and repair are invalid", async () => {
    vi.mocked(generateTextWithProvider).mockResolvedValue("not JSON");
    expect(await createPlanProposal(input)).toBeNull();
    expect(generateTextWithProvider).toHaveBeenCalledTimes(2);
  });

  it("returns null without executing a fallback when the provider fails", async () => {
    vi.mocked(generateTextWithProvider).mockRejectedValue(new Error("provider unavailable"));
    expect(await createPlanProposal(input)).toBeNull();
    expect(generateTextWithProvider).toHaveBeenCalledTimes(1);
  });
});
