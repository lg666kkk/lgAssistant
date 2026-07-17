/**
 * RAG 检索模块
 *
 * 在线链路：
 * standalone query -> multi-query rewrite -> vector/keyword parallel recall
 * -> RRF or calibrated weighted fusion -> rule/cross-encoder rerank -> vector MMR
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { ragConfig } from '@/lib/platform/config';
import {
  cosineSimilarity,
  EmbeddingClient,
  validateEmbeddingVector,
} from './embedding';
import {
  createConfiguredCrossEncoderReranker,
  type CrossEncoderReranker,
} from './reranker';

export type FusionStrategy = 'rrf' | 'weighted';
export type QueryType = 'exact' | 'semantic' | 'multi-hop' | 'balanced';
export type MmrSimilarityMode = 'vector' | 'hybrid' | 'text';
export type CrossEncoderMode = 'conditional' | 'always';

type RetrievalSource = 'vector' | 'keyword';

/**
 * 检索结果
 */
export interface SearchResult {
  id: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  content: string;
  parentContent?: string;
  parentKey?: string;
  similarity: number;
  keywordRank?: number;
  vectorScore: number;
  keywordScore: number;
  combinedScore: number;
  rrfScore?: number;
  ruleRerankScore?: number;
  crossEncoderScore?: number;
  rerankScore?: number;
  vectorRanks?: Array<{ queryIndex: number; rank: number }>;
  keywordRankPosition?: number;
  retrievalSources: RetrievalSource[];
  headingPath: string[];
  metadata?: Record<string, unknown>;
  /** 只用于进程内向量 MMR；工具输出前必须移除。 */
  embedding?: number[];
}

export interface RAGSearchDebug {
  originalQuery: string;
  standaloneQuery: string;
  queryType: QueryType;
  rewrittenQueries: string[];
  vectorQueryCount: number;
  multiQueryVectorEnabled: boolean;
  requestedMatchCount: number;
  effectiveMatchCount: number;
  candidateLimit: number;
  candidateCount: number;
  vectorCandidateCount: number;
  keywordCandidateCount: number;
  mergedCandidateCount: number;
  returnedCount: number;
  matchThreshold: number;
  fusionStrategy: FusionStrategy;
  rrfK: number;
  vectorWeight: number;
  keywordWeight: number;
  keywordSearchEnabled: boolean;
  mmrEnabled: boolean;
  mmrSimilarityMode: MmrSimilarityMode | 'disabled';
  rerankEnabled: boolean;
  crossEncoderEnabled: boolean;
  crossEncoderUsed: boolean;
  crossEncoderReason: string;
  crossEncoderError?: string;
  topScoreGap: number | null;
  timings: {
    embeddingMs: number;
    vectorSearchMs: number;
    keywordSearchMs: number;
    parallelRecallMs: number;
    crossEncoderMs: number;
    totalMs: number;
  };
}

export interface RAGSearchResponse {
  results: SearchResult[];
  debug: RAGSearchDebug;
}

export interface RAGSearchOptions {
  userId?: string;
  matchThreshold?: number;
  matchCount?: number;
  candidateCount?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  fusionStrategy?: FusionStrategy;
  rrfK?: number;
  enableDynamicWeights?: boolean;
  enableMmr?: boolean;
  mmrLambda?: number;
  enableQueryRewrite?: boolean;
  enableMultiQueryVector?: boolean;
  enableRerank?: boolean;
  enableCrossEncoder?: boolean;
  crossEncoderMode?: CrossEncoderMode;
  enableKeywordSearch?: boolean;
  conversationContext?: string[];
}

export type VectorSearchRequest = {
  query: string;
  queryIndex: number;
  embedding: number[];
  matchThreshold: number;
  matchCount: number;
  userId?: string;
};

export type KeywordSearchRequest = {
  queries: string[];
  matchCount: number;
  userId?: string;
};

export type RAGRetrieverDependencies = {
  embeddingClient?: Pick<EmbeddingClient, 'embedBatch'>;
  vectorSearch?: (request: VectorSearchRequest) => Promise<SearchResult[]>;
  keywordSearch?: (request: KeywordSearchRequest) => Promise<SearchResult[]>;
  crossEncoderReranker?: CrossEncoderReranker;
};

type RankedList = {
  source: RetrievalSource;
  queryIndex?: number;
  weight: number;
  results: SearchResult[];
};

type FusionWeights = {
  vector: number;
  keyword: number;
};

/**
 * 创建 Supabase 客户端
 */
function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('缺少 Supabase 环境变量');
  }

  return createClient(supabaseUrl, supabaseKey, {
    realtime: {
      transport: ws as any,
    },
  });
}

/**
 * RAG 检索类
 */
export class RAGRetriever {
  private embeddingClient: Pick<EmbeddingClient, 'embedBatch'>;
  private vectorSearchOverride?: RAGRetrieverDependencies['vectorSearch'];
  private keywordSearchOverride?: RAGRetrieverDependencies['keywordSearch'];
  private crossEncoderReranker?: CrossEncoderReranker;
  private supabase?: ReturnType<typeof createSupabaseClient>;

  constructor(dependencies: RAGRetrieverDependencies = {}) {
    this.embeddingClient = dependencies.embeddingClient ?? new EmbeddingClient();
    this.vectorSearchOverride = dependencies.vectorSearch;
    this.keywordSearchOverride = dependencies.keywordSearch;
    this.crossEncoderReranker = dependencies.crossEncoderReranker
      ?? createConfiguredCrossEncoderReranker();
  }

  async search(
    query: string,
    options: RAGSearchOptions = {},
  ): Promise<SearchResult[]> {
    const response = await this.searchWithDebug(query, options);
    return response.results;
  }

  async searchWithDebug(
    query: string,
    options: RAGSearchOptions = {},
  ): Promise<RAGSearchResponse> {
    const startedAt = Date.now();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('RAG 查询不能为空');
    }

    const requestedMatchCount = positiveInteger(
      options.matchCount ?? ragConfig.maxResults,
      ragConfig.maxResults,
    );
    const matchCount = Math.min(requestedMatchCount, ragConfig.maxResults);
    const candidateLimit = Math.min(
      ragConfig.maxCandidates,
      Math.max(
        matchCount,
        positiveInteger(
          options.candidateCount ?? matchCount * ragConfig.candidateMultiplier,
          matchCount,
        ),
      ),
    );
    const matchThreshold = clamp01(options.matchThreshold ?? ragConfig.similarityThreshold);
    const standaloneQuery = buildStandaloneQuery(
      normalizedQuery,
      options.conversationContext,
    );
    const queryType = classifyQuery(standaloneQuery);
    const rewrittenQueries = options.enableQueryRewrite === false
      ? [standaloneQuery]
      : rewriteQuery(standaloneQuery);
    const enableMultiQueryVector = options.enableMultiQueryVector !== false;
    const vectorQueries = enableMultiQueryVector
      ? rewrittenQueries
      : [rewrittenQueries[0]];
    const enableKeywordSearch = options.enableKeywordSearch ?? true;
    const fusionStrategy = options.fusionStrategy ?? ragConfig.fusionStrategy;
    const rrfK = positiveInteger(options.rrfK ?? ragConfig.rrfK, ragConfig.rrfK);
    const fusionWeights = resolveFusionWeights(queryType, options);

    const recallStartedAt = Date.now();
    const vectorPathPromise = this.runVectorRecall({
      queries: vectorQueries,
      matchThreshold,
      matchCount: candidateLimit,
      userId: options.userId,
    });
    const keywordPathPromise = measureAsync(
      enableKeywordSearch
        ? this.runKeywordSearch({
            queries: rewrittenQueries,
            matchCount: candidateLimit,
            userId: options.userId,
          })
        : Promise.resolve([]),
    );

    const [vectorPath, keywordPath] = await Promise.all([
      vectorPathPromise,
      keywordPathPromise,
    ]);
    const parallelRecallMs = Date.now() - recallStartedAt;

    const nonEmptyVectorLists = vectorPath.lists.filter((results) => results.length > 0);
    const vectorListWeight = nonEmptyVectorLists.length > 0
      ? fusionWeights.vector / nonEmptyVectorLists.length
      : 0;
    const rankedLists: RankedList[] = [
      ...vectorPath.lists.map((results, queryIndex) => ({
        source: 'vector' as const,
        queryIndex,
        weight: results.length > 0 ? vectorListWeight : 0,
        results,
      })),
      {
        source: 'keyword' as const,
        weight: keywordPath.value.length > 0 ? fusionWeights.keyword : 0,
        results: keywordPath.value,
      },
    ];
    const fusedCandidates = fuseRankedLists({
      lists: rankedLists,
      strategy: fusionStrategy,
      queries: rewrittenQueries,
      weights: fusionWeights,
      rrfK,
    }).sort((left, right) => right.combinedScore - left.combinedScore);
    const candidates = fusedCandidates.slice(0, candidateLimit);
    const enableRuleRerank = options.enableRerank ?? true;
    let sorted: SearchResult[] = candidates
      .map((candidate) => {
        const ruleRerankScore = enableRuleRerank
          ? ruleRerankScoreCandidate(rewrittenQueries, candidate, candidate.combinedScore)
          : candidate.combinedScore;
        return {
          ...candidate,
          ruleRerankScore,
          rerankScore: ruleRerankScore,
        };
      })
      .sort(compareByRerankScore);

    const topScoreGap = calculateTopScoreGap(sorted);
    const crossEncoderEnabled = enableRuleRerank
      && (options.enableCrossEncoder ?? ragConfig.crossEncoderEnabled);
    const crossEncoderMode = options.crossEncoderMode ?? ragConfig.crossEncoderMode;
    const crossDecision = decideCrossEncoder({
      enabled: crossEncoderEnabled,
      configured: Boolean(this.crossEncoderReranker),
      mode: crossEncoderMode,
      queryType,
      candidates: sorted,
      topScoreGap,
    });
    let crossEncoderMs = 0;
    let crossEncoderUsed = false;
    let crossEncoderError: string | undefined;

    if (crossDecision.shouldRun && this.crossEncoderReranker) {
      const crossStartedAt = Date.now();
      try {
        sorted = await applyCrossEncoderRerank({
          query: standaloneQuery,
          candidates: sorted,
          limit: ragConfig.crossEncoderCandidateCount,
          reranker: this.crossEncoderReranker,
        });
        crossEncoderUsed = true;
      } catch (error) {
        crossEncoderError = error instanceof Error ? error.message : String(error);
      } finally {
        crossEncoderMs = Date.now() - crossStartedAt;
      }
    }

    const enableMmr = options.enableMmr ?? true;
    const mmr = enableMmr
      ? applyMmr(sorted, matchCount, options.mmrLambda ?? 0.7)
      : {
          results: sorted.slice(0, matchCount),
          mode: 'disabled' as const,
        };

    return {
      results: mmr.results,
      debug: {
        originalQuery: query,
        standaloneQuery,
        queryType,
        rewrittenQueries,
        vectorQueryCount: vectorQueries.length,
        multiQueryVectorEnabled: enableMultiQueryVector,
        requestedMatchCount,
        effectiveMatchCount: matchCount,
        candidateLimit,
        candidateCount: candidates.length,
        vectorCandidateCount: vectorPath.lists.reduce((sum, list) => sum + list.length, 0),
        keywordCandidateCount: keywordPath.value.length,
        mergedCandidateCount: fusedCandidates.length,
        returnedCount: mmr.results.length,
        matchThreshold,
        fusionStrategy,
        rrfK,
        vectorWeight: fusionWeights.vector,
        keywordWeight: fusionWeights.keyword,
        keywordSearchEnabled: enableKeywordSearch,
        mmrEnabled: enableMmr,
        mmrSimilarityMode: mmr.mode,
        rerankEnabled: enableRuleRerank,
        crossEncoderEnabled,
        crossEncoderUsed,
        crossEncoderReason: crossDecision.reason,
        crossEncoderError,
        topScoreGap,
        timings: {
          embeddingMs: vectorPath.embeddingMs,
          vectorSearchMs: vectorPath.vectorSearchMs,
          keywordSearchMs: keywordPath.durationMs,
          parallelRecallMs,
          crossEncoderMs,
          totalMs: Date.now() - startedAt,
        },
      },
    };
  }

  /**
   * 格式化检索结果为上下文文本
   */
  formatContext(results: SearchResult[]): string {
    if (results.length === 0) {
      return '';
    }

    const contextParts = results.map((result, index) => {
      const heading = result.headingPath.length > 0
        ? `\n位置：${result.headingPath.join(' / ')}`
        : '';
      return `[文档 ${index + 1}] ${result.pageTitle}${heading}\n${result.parentContent ?? result.content}`;
    });

    return contextParts.join('\n\n---\n\n');
  }

  /**
   * 格式化引用信息
   */
  formatReferences(results: SearchResult[]) {
    return results.map((result, index) => ({
      index: index + 1,
      title: result.pageTitle,
      url: result.pageUrl,
      similarity: Math.round(result.similarity * 100),
      headingPath: result.headingPath,
    }));
  }

  private async runVectorRecall(input: {
    queries: string[];
    matchThreshold: number;
    matchCount: number;
    userId?: string;
  }) {
    const embeddingStartedAt = Date.now();
    const embeddings = await this.embeddingClient.embedBatch(input.queries, {
      idempotencyScope: `rag-query:${input.userId ?? 'anonymous'}`,
    });
    const embeddingMs = Date.now() - embeddingStartedAt;

    const vectorStartedAt = Date.now();
    const lists = await Promise.all(
      embeddings.map((embedding, queryIndex) => this.runVectorSearch({
        query: input.queries[queryIndex],
        queryIndex,
        embedding,
        matchThreshold: input.matchThreshold,
        matchCount: input.matchCount,
        userId: input.userId,
      })),
    );

    return {
      lists,
      embeddingMs,
      vectorSearchMs: Date.now() - vectorStartedAt,
    };
  }

  private runVectorSearch(request: VectorSearchRequest) {
    if (this.vectorSearchOverride) {
      return this.vectorSearchOverride(request);
    }
    return this.vectorSearch(request);
  }

  private runKeywordSearch(request: KeywordSearchRequest) {
    if (this.keywordSearchOverride) {
      return this.keywordSearchOverride(request);
    }
    return this.keywordSearch(request);
  }

  private getSupabase() {
    this.supabase ??= createSupabaseClient();
    return this.supabase;
  }

  private async vectorSearch(request: VectorSearchRequest): Promise<SearchResult[]> {
    const { data, error } = await this.getSupabase().rpc('match_documents', {
      query_embedding: request.embedding,
      match_threshold: request.matchThreshold,
      match_count: request.matchCount,
      filter_user_id: request.userId ?? null,
    });

    if (error) {
      throw new Error(`检索失败: ${error.message}`);
    }

    return (data || []).map((item: Record<string, unknown>) => mapSearchRow(item, 'vector'));
  }

  private async keywordSearch(request: KeywordSearchRequest): Promise<SearchResult[]> {
    const queryText = buildKeywordQuery(request.queries);
    if (!queryText) return [];

    const { data, error } = await this.getSupabase().rpc('match_documents_keyword', {
      query_text: queryText,
      match_count: request.matchCount,
      filter_user_id: request.userId ?? null,
    });

    if (error) {
      if (isMissingRpcError(error)) {
        console.warn('[rag] match_documents_keyword RPC 不存在，已降级为仅向量检索');
        return [];
      }
      throw new Error(`关键词检索失败: ${error.message}`);
    }

    return (data || []).map((item: Record<string, unknown>) => mapSearchRow(item, 'keyword'));
  }
}

function mapSearchRow(
  item: Record<string, unknown>,
  source: RetrievalSource,
): SearchResult {
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const similarity = source === 'vector' ? normalize01(item.similarity) : 0;
  const keywordRank = source === 'keyword' ? normalize01(item.keyword_rank) : undefined;
  const headingPath = Array.isArray(metadata.heading_path)
    ? metadata.heading_path.filter((value: unknown): value is string => typeof value === 'string')
    : [];

  return {
    id: String(item.id ?? ''),
    pageId: String(item.page_id ?? ''),
    pageTitle: String(item.page_title ?? ''),
    pageUrl: String(item.page_url ?? ''),
    content: String(item.content ?? ''),
    parentContent: typeof metadata.parent_content === 'string'
      ? metadata.parent_content
      : undefined,
    parentKey: typeof metadata.parent_key === 'string'
      ? metadata.parent_key
      : undefined,
    similarity,
    keywordRank,
    vectorScore: similarity,
    keywordScore: keywordRank ?? 0,
    combinedScore: Math.max(similarity, keywordRank ?? 0),
    retrievalSources: [source],
    headingPath,
    metadata,
    embedding: parseEmbeddingText(item.embedding_text),
  };
}

function fuseRankedLists(input: {
  lists: RankedList[];
  strategy: FusionStrategy;
  queries: string[];
  weights: FusionWeights;
  rrfK: number;
}): SearchResult[] {
  const accumulators = new Map<string, {
    candidate: SearchResult;
    rrfRaw: number;
    vectorCalibrated: number;
    keywordCalibrated: number;
    vectorRanks: Array<{ queryIndex: number; rank: number }>;
    keywordRankPosition?: number;
  }>();
  const activeLists = input.lists.filter((list) => list.weight > 0 && list.results.length > 0);
  const maxRrf = activeLists.reduce(
    (sum, list) => sum + list.weight / (input.rrfK + 1),
    0,
  );

  for (const list of activeLists) {
    list.results.forEach((result, index) => {
      const rank = index + 1;
      const current = accumulators.get(result.id) ?? {
        candidate: result,
        rrfRaw: 0,
        vectorCalibrated: 0,
        keywordCalibrated: 0,
        vectorRanks: [],
      };
      current.candidate = mergeSearchResult(current.candidate, result);
      current.rrfRaw += list.weight / (input.rrfK + rank);

      if (list.source === 'vector') {
        current.vectorCalibrated = Math.max(
          current.vectorCalibrated,
          calibrateListScore(result.similarity, rank, list.results.length),
        );
        current.vectorRanks.push({
          queryIndex: list.queryIndex ?? 0,
          rank,
        });
      } else {
        current.keywordCalibrated = Math.max(
          current.keywordCalibrated,
          calibrateListScore(result.keywordRank, rank, list.results.length),
        );
        current.keywordRankPosition = Math.min(
          current.keywordRankPosition ?? Number.POSITIVE_INFINITY,
          rank,
        );
      }
      accumulators.set(result.id, current);
    });
  }

  return Array.from(accumulators.values()).map((current) => {
    const localKeywordScore = scoreKeywords(input.queries, current.candidate);
    const vectorScore = current.vectorCalibrated;
    const keywordScore = Math.max(current.keywordCalibrated, localKeywordScore);
    const rrfScore = maxRrf > 0 ? normalize01(current.rrfRaw / maxRrf) : 0;
    const combinedScore = input.strategy === 'rrf'
      ? rrfScore
      : normalize01(
          vectorScore * input.weights.vector
          + keywordScore * input.weights.keyword,
        );

    return {
      ...current.candidate,
      vectorScore,
      keywordScore,
      combinedScore,
      rrfScore,
      vectorRanks: current.vectorRanks,
      keywordRankPosition: current.keywordRankPosition,
    };
  });
}

function mergeSearchResult(current: SearchResult, incoming: SearchResult): SearchResult {
  return {
    ...current,
    similarity: Math.max(current.similarity, incoming.similarity),
    keywordRank: Math.max(
      normalize01(current.keywordRank),
      normalize01(incoming.keywordRank),
    ),
    retrievalSources: Array.from(
      new Set<RetrievalSource>([
        ...current.retrievalSources,
        ...incoming.retrievalSources,
      ]),
    ),
    embedding: current.embedding ?? incoming.embedding,
    parentContent: current.parentContent ?? incoming.parentContent,
    parentKey: current.parentKey ?? incoming.parentKey,
  };
}

function calibrateListScore(rawScore: unknown, rank: number, listLength: number) {
  const rankPercentile = listLength <= 1
    ? 1
    : 1 - (rank - 1) / (listLength - 1);
  return normalize01(normalize01(rawScore) * 0.7 + rankPercentile * 0.3);
}

function resolveFusionWeights(
  queryType: QueryType,
  options: RAGSearchOptions,
): FusionWeights {
  if (
    typeof options.vectorWeight === 'number'
    || typeof options.keywordWeight === 'number'
    || options.enableDynamicWeights === false
    || !ragConfig.dynamicFusionWeights
  ) {
    return normalizeWeights(
      options.vectorWeight ?? ragConfig.vectorWeight,
      options.keywordWeight ?? ragConfig.keywordWeight,
    );
  }

  if (queryType === 'exact') return { vector: 0.45, keyword: 0.55 };
  if (queryType === 'semantic') return { vector: 0.75, keyword: 0.25 };
  if (queryType === 'multi-hop') return { vector: 0.65, keyword: 0.35 };
  return normalizeWeights(ragConfig.vectorWeight, ragConfig.keywordWeight);
}

function normalizeWeights(vectorWeight: number, keywordWeight: number) {
  const safeVector = Math.max(0, vectorWeight);
  const safeKeyword = Math.max(0, keywordWeight);
  const total = safeVector + safeKeyword;
  if (total === 0) return { vector: 0.5, keyword: 0.5 };
  return {
    vector: safeVector / total,
    keyword: safeKeyword / total,
  };
}

function ruleRerankScoreCandidate(
  queries: string[],
  candidate: SearchResult,
  baseScore: number,
) {
  const content = `${candidate.pageTitle}\n${candidate.headingPath.join(' / ')}\n${candidate.content}`.toLowerCase();
  let exactBonus = 0;
  for (const query of queries) {
    const normalized = query.toLowerCase().trim();
    if (normalized && content.includes(normalized)) {
      exactBonus = Math.max(exactBonus, 0.15);
    }
  }

  const titleBonus = queries.some((query) =>
    candidate.pageTitle.toLowerCase().includes(query.toLowerCase().trim()),
  ) ? 0.1 : 0;

  return Math.min(1, baseScore + exactBonus + titleBonus);
}

async function applyCrossEncoderRerank(input: {
  query: string;
  candidates: SearchResult[];
  limit: number;
  reranker: CrossEncoderReranker;
}) {
  const selected = input.candidates.slice(0, Math.max(1, input.limit));
  const scores = await input.reranker.rerank({
    query: input.query,
    documents: selected.map((candidate) => ({
      id: candidate.id,
      text: [
        candidate.pageTitle,
        candidate.headingPath.join(' / '),
        candidate.content,
      ].filter(Boolean).join('\n'),
    })),
  });
  if (scores.length !== selected.length) {
    throw new Error(`Cross-Encoder 返回数量不一致: ${scores.length}/${selected.length}`);
  }

  const scoreById = new Map<string, number>();
  for (const score of scores) {
    scoreById.set(selected[score.index].id, score.score);
  }

  return input.candidates
    .map((candidate) => {
      const crossEncoderScore = scoreById.get(candidate.id);
      if (crossEncoderScore === undefined) return candidate;
      const ruleScore = candidate.ruleRerankScore ?? candidate.combinedScore;
      return {
        ...candidate,
        crossEncoderScore,
        rerankScore: normalize01(crossEncoderScore * 0.85 + ruleScore * 0.15),
      };
    })
    .sort(compareByRerankScore);
}

function decideCrossEncoder(input: {
  enabled: boolean;
  configured: boolean;
  mode: CrossEncoderMode;
  queryType: QueryType;
  candidates: SearchResult[];
  topScoreGap: number | null;
}) {
  if (!input.enabled) return { shouldRun: false, reason: 'disabled' };
  if (!input.configured) return { shouldRun: false, reason: 'not_configured' };
  if (input.candidates.length < 2) return { shouldRun: false, reason: 'insufficient_candidates' };
  if (input.mode === 'always') return { shouldRun: true, reason: 'mode_always' };
  if (input.queryType === 'multi-hop') return { shouldRun: true, reason: 'multi_hop_query' };

  const topScore = input.candidates[0].rerankScore ?? input.candidates[0].combinedScore;
  if (topScore <= ragConfig.crossEncoderLowScoreThreshold) {
    return { shouldRun: true, reason: 'low_top_score' };
  }
  if (
    input.topScoreGap !== null
    && input.topScoreGap <= ragConfig.crossEncoderScoreGapThreshold
  ) {
    return { shouldRun: true, reason: 'low_score_gap' };
  }
  if (hasSourceDisagreement(input.candidates.slice(0, 3))) {
    return { shouldRun: true, reason: 'source_disagreement' };
  }
  return { shouldRun: false, reason: 'easy_query' };
}

function hasSourceDisagreement(candidates: SearchResult[]) {
  const sourcePatterns = new Set(
    candidates.map((candidate) => [...candidate.retrievalSources].sort().join('+')),
  );
  return sourcePatterns.size > 1;
}

function applyMmr(
  candidates: SearchResult[],
  limit: number,
  lambda: number,
): { results: SearchResult[]; mode: MmrSimilarityMode } {
  const selected: SearchResult[] = [];
  const remaining = [...candidates];
  const mode = detectMmrMode(candidates);
  const safeLambda = clamp01(lambda);

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      const relevance = candidate.rerankScore ?? candidate.combinedScore;
      const diversityPenalty = selected.length === 0
        ? 0
        : Math.max(...selected.map((item) => candidateSimilarity(candidate, item)));
      const score = safeLambda * relevance - (1 - safeLambda) * diversityPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return { results: selected, mode };
}

function candidateSimilarity(left: SearchResult, right: SearchResult) {
  if (left.parentKey && right.parentKey && left.parentKey === right.parentKey) {
    return 1;
  }
  if (left.embedding && right.embedding) {
    return clamp01(cosineSimilarity(left.embedding, right.embedding));
  }
  return jaccardSimilarity(left.content, right.content);
}

function detectMmrMode(candidates: SearchResult[]): MmrSimilarityMode {
  const withEmbedding = candidates.filter((candidate) => candidate.embedding).length;
  if (withEmbedding === 0) return 'text';
  if (withEmbedding === candidates.length) return 'vector';
  return 'hybrid';
}

function buildStandaloneQuery(query: string, conversationContext?: string[]) {
  const context = (conversationContext ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ')
    .slice(-600);
  const containsReference = /^(那|那么|它|这个|那个|上述|前者|后者|其|这些|那些|then\b|it\b|that\b|those\b)/i.test(query);

  if (!context || !containsReference) return query;
  return `${context}\n当前追问：${query}`;
}

function rewriteQuery(query: string): string[] {
  const normalized = query.trim();
  const variants = new Set<string>();
  if (normalized) variants.add(normalized);

  const withoutQuestionWords = normalized
    .replace(/^(请问|帮我|如何|怎么|怎样|什么是|介绍一下|解释一下)/, '')
    .replace(/[？?。.!！]/g, ' ')
    .trim();
  if (withoutQuestionWords && withoutQuestionWords !== normalized) {
    variants.add(withoutQuestionWords);
  }

  const technicalTerms = normalized.match(/[A-Za-z_][A-Za-z0-9_\-./:]+|[A-Z]{2,}|[a-z]+Error|[A-Z]+_[A-Z_]+/g);
  if (technicalTerms?.length) {
    variants.add(technicalTerms.join(' '));
  }

  return Array.from(variants).slice(0, 3);
}

function classifyQuery(query: string): QueryType {
  if (/(比较|区别|关系|共同|分别|同时|为什么.*又|如何.*并|compare|versus|difference|relationship)/i.test(query)) {
    return 'multi-hop';
  }
  if (/`[^`]+`|"[^"]+"|'[^']+'|[A-Z]{2,}[A-Z0-9_-]*|[A-Za-z]+Error|[A-Z]+_[A-Z_]+|\b\d{3,}\b/.test(query)) {
    return 'exact';
  }
  if (query.length >= 24 || /(为什么|原理|如何设计|优缺点|解释|分析)/.test(query)) {
    return 'semantic';
  }
  return 'balanced';
}

function buildKeywordQuery(queries: string[]) {
  const tokens = new Set<string>();
  for (const query of queries) {
    for (const token of Array.from(tokenize(query))) {
      tokens.add(token);
    }
  }
  return Array.from(tokens).slice(0, 16).join(' ');
}

function scoreKeywords(queries: string[], candidate: SearchResult) {
  const docTokens = tokenize(`${candidate.pageTitle} ${candidate.headingPath.join(' ')} ${candidate.content}`);
  if (docTokens.size === 0) return 0;

  let best = 0;
  for (const query of queries) {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) continue;

    let hits = 0;
    for (const token of Array.from(queryTokens)) {
      if (docTokens.has(token)) hits++;
    }
    best = Math.max(best, hits / queryTokens.size);
  }
  return best;
}

function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9_./:-]+|[\u4e00-\u9fa5]{2,}/g) ?? [];
  return new Set(tokens.map((token) => token.trim()).filter(Boolean));
}

function jaccardSimilarity(left: string, right: string) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of Array.from(leftTokens)) {
    if (rightTokens.has(token)) intersection++;
  }

  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function parseEmbeddingText(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    validateEmbeddingVector(parsed, '数据库候选');
    return parsed;
  } catch {
    return undefined;
  }
}

function calculateTopScoreGap(candidates: SearchResult[]) {
  if (candidates.length < 2) return null;
  const first = candidates[0].rerankScore ?? candidates[0].combinedScore;
  const second = candidates[1].rerankScore ?? candidates[1].combinedScore;
  return Math.max(0, first - second);
}

function compareByRerankScore(left: SearchResult, right: SearchResult) {
  return (right.rerankScore ?? right.combinedScore)
    - (left.rerankScore ?? left.combinedScore);
}

async function measureAsync<T>(promise: Promise<T>) {
  const startedAt = Date.now();
  const value = await promise;
  return {
    value,
    durationMs: Date.now() - startedAt,
  };
}

function positiveInteger(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function clamp01(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalize01(value: unknown) {
  return clamp01(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMissingRpcError(error: { code?: string; message?: string }) {
  const message = error.message ?? '';
  return (
    error.code === 'PGRST202'
    || message.includes('match_documents_keyword') && message.includes('schema cache')
  );
}
