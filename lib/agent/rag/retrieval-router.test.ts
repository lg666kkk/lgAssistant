import { describe, expect, it } from "vitest";
import {
  buildRetrievalPlan,
  filterToolsForRetrievalRoute,
  resolveRetrievalAnchor,
} from "./retrieval-router";

describe("retrieval router and query planner", () => {
  it.each([
    ["帮我把这段话改得更简洁", "no_retrieval"],
    ["查一下我的 Notion 笔记里怎么设计 RAG", "knowledge"],
    ["Next.js 最新版本发布了什么", "web"],
    ["结合我的知识库和官网最新资料比较 Agentic RAG", "both"],
    ["what did my notes say about kubernetes?", "knowledge"],
  ] as const)("routes %s to %s", (query, route) => {
    expect(buildRetrievalPlan({ query, webEnabled: true }).route).toBe(route);
  });

  it("separates soft profile routing from required evidence", () => {
    const plan = buildRetrievalPlan({
      query: "Kubernetes deployment strategy",
      knowledgeProfile: "Kubernetes deployment strategy",
    });

    expect(plan.route).toBe("knowledge");
    expect(plan.evidenceRequired).toBe(false);
    expect(buildRetrievalPlan({
      query: "what did my notes say about kubernetes?",
    }).evidenceRequired).toBe(true);
  });

  it("separates freshness routing from an explicit source requirement", () => {
    const timePlan = buildRetrievalPlan({ query: "今天几号", webEnabled: true });
    const latestPlan = buildRetrievalPlan({
      query: "Next.js 最新版本发布了什么",
      webEnabled: true,
    });
    const explicitWebPlan = buildRetrievalPlan({
      query: "联网搜索 Next.js 最新版本",
      webEnabled: true,
    });

    expect(timePlan).toMatchObject({ route: "web", evidenceRequired: false });
    expect(latestPlan).toMatchObject({ route: "web", evidenceRequired: false });
    expect(explicitWebPlan).toMatchObject({ route: "web", evidenceRequired: true });
  });

  it("decomposes a multi-hop comparison into two bounded queries", () => {
    const plan = buildRetrievalPlan({
      query: "Agentic RAG 和 RAG Agent 有什么区别？",
      knowledgeProfile: "Agentic RAG、RAG Agent、检索路由",
      indexVersion: "index-7",
    });

    expect(plan.route).toBe("knowledge");
    expect(plan.queryType).toBe("multi-hop");
    expect(plan.maxAttempts).toBe(2);
    expect(plan.steps.map((step) => step.query)).toEqual([
      "Agentic RAG",
      "RAG Agent",
    ]);
  });

  it("extracts time filters and resolves referential follow-ups", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const plan = buildRetrievalPlan({
      query: "那份笔记最近 7 天有更新吗？",
      conversationContext: ["我们正在讨论 Notion 同步设计。"],
      knowledgeProfile: "Notion 同步、笔记更新",
      now,
    });

    expect(plan.standaloneQuery).toContain("Notion 同步设计");
    expect(plan.steps[0].filters?.timeRange).toMatchObject({
      from: "2026-07-10T12:00:00.000Z",
      to: "2026-07-17T12:00:00.000Z",
      label: "最近 7 天",
    });
  });

  it("removes retrieval tools that are outside the selected route", () => {
    const tools = [
      {
        name: "private_search",
        outputPolicy: {
          grounding: "cited_evidence" as const,
          citationRequired: true,
          retrieval: { source: "knowledge" as const, maxCallsPerRun: 1 },
        },
      },
      {
        name: "public_search",
        outputPolicy: {
          grounding: "cited_evidence" as const,
          citationRequired: true,
          retrieval: { source: "web" as const, maxCallsPerRun: 1 },
        },
      },
      {
        name: "calculator",
        outputPolicy: {
          grounding: "authoritative_result" as const,
          citationRequired: false,
        },
      },
    ];

    // 联网开启时 route 只是优先级：knowledge 路由保留 Web 工具作为兜底，
    // 先后顺序交给 Prompt 的检索计划段表达，不靠削减工具集实现。
    expect(filterToolsForRetrievalRoute(tools, "knowledge").map((tool) => tool.name))
      .toEqual(["private_search", "public_search", "calculator"]);
    expect(filterToolsForRetrievalRoute(tools, "knowledge", { webEnabled: true })
      .map((tool) => tool.name))
      .toEqual(["private_search", "public_search", "calculator"]);
    // 联网关闭是硬边界：Web 工具在任何 route 下都不可见。
    expect(filterToolsForRetrievalRoute(tools, "knowledge", { webEnabled: false })
      .map((tool) => tool.name))
      .toEqual(["private_search", "calculator"]);
    // web 路由仍然只保留 Web 检索源，知识库工具按 route 收窄。
    expect(filterToolsForRetrievalRoute(tools, "web").map((tool) => tool.name))
      .toEqual(["public_search", "calculator"]);
    expect(filterToolsForRetrievalRoute(tools, "no_retrieval").map((tool) => tool.name))
      .toEqual(["private_search", "public_search", "calculator"]);
    expect(filterToolsForRetrievalRoute(tools, "no_retrieval", { webEnabled: false })
      .map((tool) => tool.name))
      .toEqual(["private_search", "calculator"]);
  });

  it("does not treat a saved webpage link as a web source inside the knowledge index", () => {
    const plan = buildRetrievalPlan({
      query: "我之前收藏的那个讲 RAG 的网页链接是什么",
    });

    expect(plan.route).toBe("knowledge");
    expect(plan.steps[0].filters?.sourceTypes).toBeUndefined();
  });

  it("normalizes Notion page ids before creating filters", () => {
    const plan = buildRetrievalPlan({
      query: "查一下 Notion 页面 550E8400-E29B-41D4-A716-446655440000",
    });

    expect(plan.steps[0].filters?.pageIds).toEqual([
      "550e8400e29b41d4a716446655440000",
    ]);
  });

  it("reuses the original task when an approved plan is executed or retried", () => {
    const messages = [
      { role: "user", content: "查我的知识库，然后比较最新公开资料" },
      { role: "assistant", content: "请审核计划" },
      { role: "user", content: "执行已确认的计划" },
      { role: "assistant", content: "步骤失败" },
      { role: "user", content: "重试失败步骤" },
    ];

    expect(resolveRetrievalAnchor(messages, true)).toMatchObject({
      query: "查我的知识库，然后比较最新公开资料",
    });
    expect(resolveRetrievalAnchor(messages.slice(0, 3), true)).toMatchObject({
      query: "查我的知识库，然后比较最新公开资料",
      foundPriorTask: true,
    });
    expect(resolveRetrievalAnchor([
      { role: "user", content: "执行已确认的计划" },
    ], true).foundPriorTask).toBe(false);
  });
});
