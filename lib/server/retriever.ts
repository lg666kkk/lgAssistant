/**
 * RAG 检索模块
 *
 * 当前实现是“可直接落地”的混合检索第一版：
 * - pgvector 做第一阶段快速召回
 * - 本地关键词得分补足精确术语/错误码/API 名称
 * - 候选采样先多取，再用 MMR 去重
 * - 轻量规则 rerank，不额外引入模型调用成本
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { EmbeddingClient } from './embedding';

const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_KEYWORD_WEIGHT = 0.3;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MAX_CANDIDATES = 50;

/**
 * 检索结果
 */
export interface SearchResult {
  id: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  content: string;
  similarity: number;
  vectorScore: number;
  keywordScore: number;
  combinedScore: number;
  rerankScore?: number;
  headingPath: string[];
  metadata?: Record<string, unknown>;
}

export interface RAGSearchDebug {
  originalQuery: string;
  rewrittenQueries: string[];
  candidateCount: number;
  returnedCount: number;
  matchThreshold: number;
  vectorWeight: number;
  keywordWeight: number;
  mmrEnabled: boolean;
  rerankEnabled: boolean;
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
  enableMmr?: boolean;
  mmrLambda?: number;
  enableQueryRewrite?: boolean;
  enableRerank?: boolean;
}

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
  private embeddingClient: EmbeddingClient;
  private supabase: ReturnType<typeof createSupabaseClient>;

  constructor() {
    this.embeddingClient = new EmbeddingClient();
    this.supabase = createSupabaseClient();
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
    const matchCount = options.matchCount ?? 5;
    const matchThreshold = options.matchThreshold ?? 0.7;
    const candidateCount =
      options.candidateCount ??
      Math.min(DEFAULT_MAX_CANDIDATES, Math.max(matchCount, matchCount * DEFAULT_CANDIDATE_MULTIPLIER));
    const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
    const enableMmr = options.enableMmr ?? true;
    const enableRerank = options.enableRerank ?? true;
    const rewrittenQueries = options.enableQueryRewrite === false
      ? [query]
      : rewriteQuery(query);

    const queryEmbedding = await this.embeddingClient.embedSingle(rewrittenQueries[0]);
    const candidates = await this.vectorSearch(queryEmbedding, {
      userId: options.userId,
      matchThreshold,
      matchCount: candidateCount,
    });

    const scored = candidates.map((candidate) => {
      const keywordScore = scoreKeywords(rewrittenQueries, candidate);
      const vectorScore = normalize01(candidate.similarity);
      const combinedScore = vectorScore * vectorWeight + keywordScore * keywordWeight;
      const rerankScore = enableRerank
        ? rerankScoreCandidate(rewrittenQueries, candidate, combinedScore)
        : combinedScore;

      return {
        ...candidate,
        vectorScore,
        keywordScore,
        combinedScore,
        rerankScore,
      };
    });

    const sorted = scored.sort(
      (a, b) => (b.rerankScore ?? b.combinedScore) - (a.rerankScore ?? a.combinedScore),
    );
    const diversified = enableMmr
      ? applyMmr(sorted, matchCount, options.mmrLambda ?? DEFAULT_MMR_LAMBDA)
      : sorted.slice(0, matchCount);

    return {
      results: diversified,
      debug: {
        originalQuery: query,
        rewrittenQueries,
        candidateCount: candidates.length,
        returnedCount: diversified.length,
        matchThreshold,
        vectorWeight,
        keywordWeight,
        mmrEnabled: enableMmr,
        rerankEnabled: enableRerank,
      },
    };
  }

  private async vectorSearch(
    queryEmbedding: number[],
    options: {
      matchThreshold: number;
      matchCount: number;
      userId?: string;
    },
  ): Promise<SearchResult[]> {
    const { data, error } = await this.supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: options.matchThreshold,
      match_count: options.matchCount,
      filter_user_id: options.userId ?? null,
    });

    if (error) {
      throw new Error(`检索失败: ${error.message}`);
    }

    return (data || []).map((item: any) => {
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      return {
        id: item.id,
        pageId: item.page_id,
        pageTitle: item.page_title,
        pageUrl: item.page_url,
        content: item.content,
        similarity: item.similarity,
        vectorScore: normalize01(item.similarity),
        keywordScore: 0,
        combinedScore: normalize01(item.similarity),
        headingPath: Array.isArray(metadata.heading_path)
          ? metadata.heading_path.filter((v: unknown): v is string => typeof v === 'string')
          : [],
        metadata,
      };
    });
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
      return `[文档 ${index + 1}] ${result.pageTitle}${heading}\n${result.content}`;
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

function rerankScoreCandidate(
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

function applyMmr(
  candidates: SearchResult[],
  limit: number,
  lambda: number,
) {
  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.rerankScore ?? candidate.combinedScore;
      const diversityPenalty = selected.length === 0
        ? 0
        : Math.max(...selected.map((item) => jaccardSimilarity(candidate.content, item.content)));
      const score = lambda * relevance - (1 - lambda) * diversityPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9_./:-]+|[\u4e00-\u9fa5]{2,}/g) ?? [];
  return new Set(tokens.map((token) => token.trim()).filter(Boolean));
}

function jaccardSimilarity(a: string, b: string) {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of Array.from(aTokens)) {
    if (bTokens.has(token)) intersection++;
  }

  return intersection / (aTokens.size + bTokens.size - intersection);
}

function normalize01(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
