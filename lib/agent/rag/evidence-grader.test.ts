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

describe('knowledge sufficiency regression', () => {
  it('does not treat a high similarity score or dual recall as an answer', () => {
    const grade = gradeKnowledgeEvidence('班主任手机号', [result({ similarity: 0.95 })], ['ev_aaaaaaaaaaaa']);
    expect(grade.sufficient).toBe(false);
    expect(grade.acceptedEvidenceIds).toEqual([]);
  });
  it('does not count duplicate children as independent evidence', () => {
    const chunks = [result({ content: 'alpha', similarity: 0.4, retrievalSources: ["vector"], parentKey: 'same' }),
      result({ id: 'chunk-2', content: 'beta gamma', similarity: 0.4, retrievalSources: ["vector"], parentKey: 'same' })];
    const grade = gradeKnowledgeEvidence('alpha beta gamma', chunks, ['ev_aaaaaaaaaaaa', 'ev_bbbbbbbbbbbb']);
    expect(grade.queryCoverage).toBe(1);
    expect(grade.sufficient).toBe(false);
  });
  it('accepts complementary evidence from independent sources', () => {
    const chunks = [result({ content: 'alpha', similarity: 0.4 }),
      result({ id: 'chunk-2', pageId: 'page-2', content: 'beta gamma', similarity: 0.4 })];
    expect(gradeKnowledgeEvidence('alpha beta gamma', chunks, ['a', 'b']).sufficient).toBe(true);
  });
  it('rejects partial topic coverage even when multiple sources agree', () => {
    const chunks = [result({ content: 'alpha', similarity: 0.9 }),
      result({ id: 'chunk-2', pageId: 'page-2', content: 'alpha', similarity: 0.9 })];
    expect(gradeKnowledgeEvidence('alpha beta gamma delta', chunks, ['a', 'b'])).toMatchObject({
      sufficient: false, reason: 'incomplete_query_coverage', queryCoverage: 0.25,
    });
  });
  it('requires numerical constraints to appear in evidence', () => {
    const grade = gradeKnowledgeEvidence('RAG embedding 1024', [result({
      content: 'RAG embedding 768', similarity: 0.9,
    })], ['a']);
    expect(grade).toMatchObject({ sufficient: false, reason: 'missing_query_condition' });
  });
  it('requires quoted entities instead of a similarly named topic', () => {
    expect(gradeKnowledgeEvidence('RAG "text-embedding-v4"', [result({
      content: 'RAG text-embedding-v3', similarity: 0.95,
    })], ['a']).sufficient).toBe(false);
  });
  it('does not accept a matching title with an unrelated body', () => {
    expect(gradeKnowledgeEvidence('RAG 检索设计', [result({
      content: '天气晴朗。', similarity: 0.9,
    })], ['a']).acceptedEvidenceIds).toEqual([]);
  });
});
