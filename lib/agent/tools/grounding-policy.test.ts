import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "./builtin";
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
});
