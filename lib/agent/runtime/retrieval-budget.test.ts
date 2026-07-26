import { describe, expect, it, vi } from "vitest";
import {
  callModel,
  runAgentLoop,
} from "./index";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { defaultToolRuntimePolicy } from "@/lib/agent/tools/types";

describe("agent retrieval tool budget", () => {
  it("executes the allowed call and skips only the excess parallel call", async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      content: "retrieval completed",
    }));
    const registry = new ToolRegistry();
    registry.register({
      name: "search_notes",
      description: "search",
      capabilities: ["private.knowledge.search"],
      outputPolicy: {
        grounding: "cited_evidence",
        citationRequired: true,
        retrieval: { source: "knowledge", maxCallsPerRun: 1 },
      },
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      riskLevel: "safe",
      runtime: { ...defaultToolRuntimePolicy, concurrencyGroup: "knowledge" },
      execute,
    });
    const callModelMock = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "notes-redis", name: "search_notes", input: { query: "Redis" } },
          { type: "tool_use", id: "notes-kafka", name: "search_notes", input: { query: "Kafka" } },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "基于已执行的检索继续回答。" }],
        stop_reason: "end_turn",
      });

    const result = await runAgentLoop(
      [{ role: "user", content: "比较 Redis 和 Kafka 笔记" }],
      registry.listForModel(),
      registry,
      3,
      [],
      () => true,
      "request-budget",
      "session-budget",
      { callModel: callModelMock as unknown as typeof callModel },
    );

    const toolResultTexts = result.loopMessages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((block) =>
            block.type === "tool_result" && typeof block.content === "string"
              ? [block.content]
              : [])
        : []);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { query: "Redis" },
      expect.objectContaining({ userId: undefined }),
    );
    expect(toolResultTexts).toHaveLength(2);
    expect(toolResultTexts.some((text) => text.includes("检索预算"))).toBe(true);
    expect(result.completed).toBe(true);
  });
});
