import { describe, expect, it } from "vitest";
import { buildContextUsageBreakdown } from "./context-usage";

describe("context usage breakdown", () => {
  it("separates prompt segments, tool schemas, and retrieval results", () => {
    const breakdown = buildContextUsageBreakdown({
      totalTokens: 1_000,
      system: "identity\n\nremember this\n\nknowledge",
      systemSegments: [
        { kind: "identity", content: "identity" },
        { kind: "memory", content: "remember this" },
        { kind: "task-context", content: "knowledge" },
      ],
      tools: [{ name: "web_search", description: "search", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "查新闻" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "web_search", input: { query: "news" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "search results" }] },
      ],
    });

    expect(breakdown.memoryTokens).toBeGreaterThan(0);
    expect(breakdown.knowledgeRagTokens).toBeGreaterThan(0);
    expect(breakdown.webRetrievalTokens).toBeGreaterThan(0);
    expect(breakdown.toolSchemaTokens).toBeGreaterThan(0);
    expect(Object.values(breakdown).reduce((sum, value) => sum + value, 0)).toBe(1_000);
  });

  it("attributes artifact pages to the originating retrieval tool", () => {
    const breakdown = buildContextUsageBreakdown({
      totalTokens: 500,
      tools: [],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read_tool_artifact", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "tool: web_search\npage content" }] },
      ],
    });

    expect(breakdown.webRetrievalTokens).toBeGreaterThan(0);
  });
});
