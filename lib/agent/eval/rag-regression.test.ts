import { describe, expect, it } from 'vitest';
import { RAGRetriever, type SearchResult } from '@/lib/knowledge/retriever';
import { createSearchNotesTool } from '@/lib/agent/tools/search-notes';
import { QueryResultCache } from '@/lib/agent/rag/query-cache';
import { buildRetrievalPlan } from '@/lib/agent/rag/retrieval-router';
import { countTokensFromText } from '@/lib/agent/runtime/tokenizer';
import type { EvidenceBundle } from '@/lib/agent/rag/types';
import { ragFixtureSources, ragRegressionCases } from './datasets/rag-regression';

/** Fixed recall scores deliberately include unrelated candidates with high similarity.
 * This evaluates the real fusion/MMR/tool/visible-evidence path, not provider embeddings. */
describe('RAG source-labelled context regression (offline fixtures)', () => {
  it.each(ragRegressionCases)('$id: $question', async (testCase) => {
    const candidates: SearchResult[] = Array.from(new Set(testCase.candidateSources)).map((id) => ({
      id: `fixture-${id}`, pageId: id, pageTitle: id, pageUrl: `https://example.test/${id}`,
      content: ragFixtureSources[id].text, parentContent: '无关的页面背景。'.repeat(700) + ragFixtureSources[id].text,
      parentKey: id, headingPath: [], similarity: .8, vectorScore: .8, keywordScore: 0,
      combinedScore: .8, retrievalSources: ['vector'], metadata: { fixtureSource: ragFixtureSources[id].path },
    }));
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: async (queries) => queries.map(() => [1, 0]) },
      vectorSearch: async () => candidates, keywordSearch: async () => [],
    });
    const plan = buildRetrievalPlan({ query: testCase.question, indexVersion: 'offline-fixtures-v1',
      routeDecisionOverride: { route: 'knowledge', reason: 'fixture', confidence: 1, freshnessRequired: false, evidenceRequired: true } });
    if (testCase.subqueries) {
      plan.queryType = 'multi-hop';
      plan.steps = testCase.subqueries.map((query, index) => ({ id: `hop-${index}`, source: 'knowledge', query,
        purpose: index === 0 ? 'primary_retrieval' : 'multi_hop_or_rewrite' }));
    }
    const tool = createSearchNotesTool({ retriever, retrievalPlan: plan, cache: new QueryResultCache() });
    const result = await tool.execute({ query: testCase.question }, { userId: 'fixture-user' });
    expect(result.ok).toBe(true);
    const data = result.data as { results: SearchResult[]; evidenceBundle: EvidenceBundle };
    expect(data.evidenceBundle.grade.sufficient).toBe(testCase.expectedEvidenceSufficient);
    if (testCase.expectedNoResult) {
      expect(data.results).toHaveLength(0);
      expect(data.evidenceBundle.evidences).toHaveLength(0);
    } else {
      const sources = new Set(data.results.map((item) => item.pageId));
      for (const source of testCase.expectedAllSources) expect(sources).toContain(source);
      const visible = data.evidenceBundle.evidences.map((item) => item.content).join('\n');
      for (const keyword of testCase.expectedKeywords ?? []) expect(visible).toContain(keyword);
      expect(countTokensFromText(result.content)).toBeLessThanOrEqual(2400);
      for (const evidence of data.evidenceBundle.evidences) expect(result.content).toContain(`[${evidence.evidenceId}]`);
    }
  });
});
