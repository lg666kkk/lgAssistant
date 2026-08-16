import { describe, expect, it, vi } from 'vitest';
import { QueryResultCache } from '@/lib/agent/rag/query-cache';
import {
  type CachedQueryEmbedding,
  RAGRetriever,
  type SearchResult,
} from './retriever';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function result(
  id: string,
  similarity: number,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return {
    id,
    pageId: `page-${id}`,
    pageTitle: `Document ${id}`,
    pageUrl: `https://example.com/${id}`,
    content: `content for ${id}`,
    similarity,
    vectorScore: similarity,
    keywordScore: 0,
    combinedScore: similarity,
    retrievalSources: ['vector'],
    headingPath: [],
    ...overrides,
  };
}

describe('RAGRetriever advanced retrieval', () => {
  it('runs keyword recall in parallel with embedding and executes every vector rewrite', async () => {
    const embeddingGate = deferred<number[][]>();
    const keywordGate = deferred<SearchResult[]>();
    const embedBatch = vi.fn(async (_queries: string[]) => embeddingGate.promise);
    const keywordSearch = vi.fn(async () => keywordGate.promise);
    const vectorSearch = vi.fn(async () => []);
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch },
      vectorSearch,
      keywordSearch,
    });

    const searchPromise = retriever.searchWithDebug('请问 RAG Error 怎么解决？', {
      enableCrossEncoder: false,
    });

    await vi.waitFor(() => {
      expect(embedBatch).toHaveBeenCalledTimes(1);
      expect(keywordSearch).toHaveBeenCalledTimes(1);
    });
    const vectorQueries = embedBatch.mock.calls[0]?.[0] ?? [];
    expect(vectorQueries).toHaveLength(3);

    embeddingGate.resolve(vectorQueries.map((_, index) => [index + 1, 0]));
    await vi.waitFor(() => expect(vectorSearch).toHaveBeenCalledTimes(3));
    keywordGate.resolve([]);

    const response = await searchPromise;
    expect(response.debug.vectorQueryCount).toBe(3);
    expect(response.debug.multiQueryVectorEnabled).toBe(true);
    expect(response.debug.keywordSearchEnabled).toBe(true);
  });

  it('reports a bounded parallel recall timeout instead of waiting indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const retriever = new RAGRetriever({
        embeddingClient: { embedBatch: vi.fn(() => new Promise<number[][]>(() => {})) },
        keywordSearch: vi.fn(() => new Promise<SearchResult[]>(() => {})),
      });

      const searchPromise = retriever.searchWithDebug('RAG 超时诊断', {
        timeoutMs: 1_000,
      });
      const rejection = expect(searchPromise).rejects.toMatchObject({
        name: 'RAGRetrievalTimeoutError',
        phase: 'parallel_recall',
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses RRF consensus across vector rewrites and enforces the global TopK cap', async () => {
    const embedBatch = vi.fn(async (queries: string[]) =>
      queries.map((_, index) => [index + 1, 0]));
    const vectorSearch = vi.fn(async ({ queryIndex }: { queryIndex: number }) => {
      if (queryIndex === 0) {
        return [result('B', 0.91), result('A', 0.89), result('C', 0.8)];
      }
      if (queryIndex === 1) {
        return [result('A', 0.9), result('D', 0.82), result('E', 0.8)];
      }
      return [result('A', 0.88), result('F', 0.81), result('G', 0.79)];
    });
    const keywordSearch = vi.fn(async () => [
      result('B', 0, { keywordRank: 0.9, retrievalSources: ['keyword'] }),
      result('A', 0, { keywordRank: 0.8, retrievalSources: ['keyword'] }),
    ]);
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch },
      vectorSearch,
      keywordSearch,
    });

    const response = await retriever.searchWithDebug('请问 RAG Error 怎么解决？', {
      matchCount: 99,
      candidateCount: 99,
      fusionStrategy: 'rrf',
      enableMmr: false,
      enableCrossEncoder: false,
    });

    expect(response.results[0].id).toBe('A');
    expect(response.results).toHaveLength(5);
    expect(response.debug.requestedMatchCount).toBe(99);
    expect(response.debug.effectiveMatchCount).toBe(5);
    expect(response.debug.candidateLimit).toBe(50);
    expect(response.debug.fusionStrategy).toBe('rrf');
    expect(response.results[0].vectorRanks).toHaveLength(3);
  });

  it('keeps calibrated weighted fusion as an ablation strategy', async () => {
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => [result('vector', 0.9)]),
      keywordSearch: vi.fn(async () => [
        result('keyword', 0, {
          keywordRank: 0.9,
          retrievalSources: ['keyword'],
        }),
      ]),
    });

    const response = await retriever.searchWithDebug('普通问题', {
      fusionStrategy: 'weighted',
      enableDynamicWeights: false,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      enableQueryRewrite: false,
      enableMmr: false,
      enableCrossEncoder: false,
    });

    expect(response.debug.fusionStrategy).toBe('weighted');
    expect(response.results.map((item) => item.id)).toEqual(['vector', 'keyword']);
    expect(response.results[0].combinedScore).toBeGreaterThan(
      response.results[1].combinedScore,
    );
  });

  it('caps the fused rerank pool even when every recall path returns unique candidates', async () => {
    const retriever = new RAGRetriever({
      embeddingClient: {
        embedBatch: vi.fn(async (queries: string[]) =>
          queries.map((_, index) => [index + 1, 0])),
      },
      vectorSearch: vi.fn(async ({ queryIndex }: { queryIndex: number }) =>
        Array.from({ length: 50 }, (_, index) =>
          result(`vector-${queryIndex}-${index}`, 1 - index / 100))),
      keywordSearch: vi.fn(async () =>
        Array.from({ length: 50 }, (_, index) =>
          result(`keyword-${index}`, 0, {
            keywordRank: 1 - index / 100,
            retrievalSources: ['keyword'],
          }))),
    });

    const response = await retriever.searchWithDebug('请问 RAG Error 怎么解决？', {
      candidateCount: 999,
      enableMmr: false,
      enableCrossEncoder: false,
    });

    expect(response.debug.mergedCandidateCount).toBe(200);
    expect(response.debug.candidateCount).toBe(50);
    expect(response.debug.candidateLimit).toBe(50);
  });

  it('uses candidate vectors for MMR diversity', async () => {
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => [
        result('A', 0.9, { embedding: [1, 0] }),
        result('B', 0.89, { embedding: [0.999, 0.001] }),
        result('C', 0.8, { embedding: [0, 1] }),
      ]),
      keywordSearch: vi.fn(async () => []),
    });

    const response = await retriever.searchWithDebug('语义问题分析', {
      matchCount: 2,
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableCrossEncoder: false,
      mmrLambda: 0.5,
    });

    expect(response.results.map((item) => item.id)).toEqual(['A', 'C']);
    expect(response.debug.mmrSimilarityMode).toBe('vector');
  });

  it('conditionally invokes the cross-encoder for a low score gap', async () => {
    const rerank = vi.fn(async () => [
      { index: 0, score: 0.1 },
      { index: 1, score: 0.9 },
    ]);
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => [
        result('A', 0.9, { embedding: [1, 0] }),
        result('B', 0.89, { embedding: [0, 1] }),
      ]),
      keywordSearch: vi.fn(async () => []),
      crossEncoderReranker: { rerank },
    });

    const response = await retriever.searchWithDebug('普通问题', {
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableMmr: false,
      enableCrossEncoder: true,
      crossEncoderMode: 'conditional',
    });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(response.results.map((item) => item.id)).toEqual(['B', 'A']);
    expect(response.debug.crossEncoderUsed).toBe(true);
    expect(response.debug.crossEncoderReason).toBe('low_score_gap');
  });

  it('builds a standalone query for referential follow-ups when context is supplied', async () => {
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => []),
      keywordSearch: vi.fn(async () => []),
    });

    const response = await retriever.searchWithDebug('那它呢？', {
      conversationContext: ['上一轮讨论 PostgreSQL HNSW 索引'],
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableCrossEncoder: false,
    });

    expect(response.debug.standaloneQuery).toContain('PostgreSQL HNSW');
    expect(response.debug.standaloneQuery).toContain('那它呢');
  });

  it('caches query embeddings by tenant and index version', async () => {
    const embedBatch = vi.fn(async (_queries: string[], options?: any) => {
      options?.onEvent?.({
        type: 'batch_done',
        inputTokens: 6,
        totalTokens: 6,
      });
      return [[1, 0]];
    });
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch },
      embeddingCache: new QueryResultCache<CachedQueryEmbedding>(),
      vectorSearch: vi.fn(async () => []),
      keywordSearch: vi.fn(async () => []),
    });
    const options = {
      userId: 'user-1',
      indexVersion: 'index-1',
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableCrossEncoder: false,
    };

    const first = await retriever.searchWithDebug('RAG cache', options);
    const second = await retriever.searchWithDebug('RAG cache', options);
    await retriever.searchWithDebug('RAG cache', { ...options, indexVersion: 'index-2' });

    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(first.debug.timings).toMatchObject({
      embeddingCacheHits: 0,
      embeddingCacheMisses: 1,
    });
    expect(first.debug.embeddingUsage).toMatchObject({
      model: 'text-embedding-v4',
      inputTokens: 6,
      cacheHitTokens: 0,
      cacheMissTokens: 6,
      modelCallCount: 1,
    });
    expect(second.debug.timings).toMatchObject({
      embeddingCacheHits: 1,
      embeddingCacheMisses: 0,
    });
    expect(second.debug.embeddingUsage).toMatchObject({
      inputTokens: 0,
      cacheHitTokens: 6,
      cacheMissTokens: 0,
      modelCallCount: 0,
      cacheHitCalls: 1,
    });
  });

  it('applies planned source filters to recalled candidates', async () => {
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => [
        result('notion', 0.9),
        result('document', 0.8, { metadata: { source_type: 'document' } }),
      ]),
      keywordSearch: vi.fn(async () => []),
    });

    const response = await retriever.searchWithDebug('检索文档', {
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableCrossEncoder: false,
      enableMmr: false,
      filters: { sourceTypes: ['document'] },
    });

    expect(response.results.map((item) => item.id)).toEqual(['document']);
    expect(response.debug.filteredCandidateCount).toBe(1);
  });

  it('normalizes page id filters before comparing candidates', async () => {
    const pageId = '550e8400e29b41d4a716446655440000';
    const retriever = new RAGRetriever({
      embeddingClient: { embedBatch: vi.fn(async () => [[1, 0]]) },
      vectorSearch: vi.fn(async () => [
        result('notion-page', 0.9, { pageId }),
      ]),
      keywordSearch: vi.fn(async () => []),
    });

    const response = await retriever.searchWithDebug('检索指定页面', {
      enableQueryRewrite: false,
      enableKeywordSearch: false,
      enableCrossEncoder: false,
      enableMmr: false,
      filters: { pageIds: ['550E8400-E29B-41D4-A716-446655440000'] },
    });

    expect(response.results.map((item) => item.pageId)).toEqual([pageId]);
  });
});
