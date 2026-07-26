import { describe, expect, it } from "vitest";
import { buildRetrievalPlan } from "@/lib/agent/rag/retrieval-router";
import { createBuiltinToolRegistry } from "./builtin";
import {
  expandToolNamesWithPrerequisites,
  missingToolPrerequisites,
  renderToolOrchestrationPolicy,
} from "./orchestration";

describe("tool orchestration metadata", () => {
  const registry = createBuiltinToolRegistry();
  const webSearch = registry.get("web_search")!;

  it("activates time prerequisites only for public freshness tasks", () => {
    const freshPlan = buildRetrievalPlan({ query: "今天有哪些 AI 新闻" });
    const docsPlan = buildRetrievalPlan({ query: "联网查 OpenAI 官网文档" });

    expect(freshPlan.freshnessRequired).toBe(true);
    expect(missingToolPrerequisites(webSearch, new Set(), freshPlan))
      .toEqual(["time.current"]);
    expect(missingToolPrerequisites(webSearch, new Set(["time.current"]), freshPlan))
      .toEqual([]);
    expect(docsPlan.freshnessRequired).toBe(false);
    expect(missingToolPrerequisites(webSearch, new Set(), docsPlan)).toEqual([]);
  });

  it("renders active orchestration rules from tool metadata", () => {
    const content = renderToolOrchestrationPolicy(
      registry.list(),
      buildRetrievalPlan({ query: "查询最新 Next.js 版本" }),
    );

    expect(content).toContain("public_freshness_required");
    expect(content).toContain("time.current (get_current_time)");
    expect(content).toContain("调用 web_search 前");
  });

  it("expands plan tool scopes with active prerequisite providers", () => {
    const expanded = expandToolNamesWithPrerequisites(
      ["web_search"],
      registry.list(),
      buildRetrievalPlan({ query: "查询最新 Next.js 版本" }),
    );

    expect(expanded).toEqual(new Set(["web_search", "get_current_time"]));
  });
});
