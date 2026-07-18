import { describe, expect, it } from "vitest";
import type { SearchResult } from "@/lib/knowledge/retriever";
import { gradeKnowledgeEvidence } from "./evidence-grader";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chunk-1",
    pageId: "page-1",
    pageTitle: "RAG 检索设计",
    pageUrl: "https://example.com/rag",
    content: "RAG 通过向量和关键词检索召回证据。",
    similarity: 0.4,
    vectorScore: 0.4,
    keywordScore: 0.38,
    combinedScore: 0.4,
    retrievalSources: ["vector", "keyword"],
    headingPath: ["检索"],
    ...overrides,
  };
}

describe("evidence grader", () => {
  it("accepts vector and keyword agreement as sufficient evidence", () => {
    const grade = gradeKnowledgeEvidence(
      "RAG 如何召回证据",
      [result()],
      ["ev_aaaaaaaaaaaa"],
    );

    expect(grade).toMatchObject({
      sufficient: true,
      reason: "vector_keyword_agreement",
      acceptedEvidenceIds: ["ev_aaaaaaaaaaaa"],
    });
  });

  it("rejects a weak unrelated candidate without lowering a threshold", () => {
    const grade = gradeKnowledgeEvidence(
      "小学班主任手机号",
      [result({
        pageTitle: "RAG 设计",
        content: "向量检索与关键词召回。",
        similarity: 0.36,
        vectorScore: 0.36,
        keywordScore: 0,
        combinedScore: 0.2,
        retrievalSources: ["vector"],
      })],
      ["ev_bbbbbbbbbbbb"],
    );

    expect(grade.sufficient).toBe(false);
    expect(grade.acceptedEvidenceIds).toEqual([]);
    expect(grade.reason).toBe("low_query_coverage");
  });

  it("returns an explicit no-results grade", () => {
    expect(gradeKnowledgeEvidence("missing", [], [])).toMatchObject({
      sufficient: false,
      grade: "none",
      reason: "no_results",
      topScore: null,
    });
  });
});
