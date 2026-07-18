import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import { createWebFetchTool } from "./web-fetch";

function plan(query = "Agentic RAG retrieval router"): RetrievalPlan {
  return {
    id: "retrieval-fetch-test",
    version: AGENTIC_RAG_VERSION,
    route: "web",
    originalQuery: query,
    standaloneQuery: query,
    queryType: "semantic",
    reason: "fresh_or_public_information_required",
    confidence: 1,
    evidenceRequired: true,
    maxAttempts: 2,
    indexVersion: "web-live",
    steps: [],
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

function html(body: string) {
  return new Response(
    `<html><head><title>Agentic RAG</title></head><body><main>${body}</main></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

describe("web_fetch evidence contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds an evidence id when fetched正文 supports the planned query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(
      "Agentic RAG uses an explicit retrieval router to choose knowledge or web evidence. ".repeat(4),
    )));
    const result = await createWebFetchTool({ retrievalPlan: plan() }).execute({
      url: "https://example.com/agentic-rag",
    });
    const bundle = (result.data as { evidenceBundle: EvidenceBundle }).evidenceBundle;

    expect(bundle.grade.sufficient).toBe(true);
    expect(bundle.evidences).toHaveLength(1);
    expect(result.content).toContain(`[${bundle.evidences[0].evidenceId}]`);
  });

  it("keeps fetched正文 available when lexical grading is insufficient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(
      "This article contains cooking recipes, kitchen tips, ingredients, and meal planning. ".repeat(4),
    )));
    const result = await createWebFetchTool({ retrievalPlan: plan("总结这个分布式一致性网页") }).execute({
      url: "https://example.com/cooking",
    });
    const bundle = (result.data as { evidenceBundle: EvidenceBundle }).evidenceBundle;

    expect(bundle.grade.sufficient).toBe(false);
    expect(bundle.evidences).toHaveLength(1);
    expect(result.content).toContain("cooking recipes");
    expect(result.content).toContain("页面已成功读取");
  });
});
