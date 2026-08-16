export type CrossEncoderDocument = {
  id: string;
  text: string;
};

export type CrossEncoderScore = {
  index: number;
  score: number;
};

export type CrossEncoderProviderResponse = {
  requestId?: string;
  model?: string;
  totalTokens?: number;
};

export type CrossEncoderScores = CrossEncoderScore[] & {
  providerResponse?: CrossEncoderProviderResponse;
};

export type CrossEncoderReranker = {
  rerank(input: {
    query: string;
    documents: CrossEncoderDocument[];
  }): Promise<CrossEncoderScores>;
};

type HttpRerankerOptions = {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  instruct?: string;
  fetchImpl?: typeof fetch;
};

export class HttpCrossEncoderReranker implements CrossEncoderReranker {
  private url: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private instruct?: string;
  private fetchImpl: typeof fetch;

  constructor(options: HttpRerankerOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.instruct = options.instruct;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async rerank(input: {
    query: string;
    documents: CrossEncoderDocument[];
  }): Promise<CrossEncoderScores> {
    if (input.documents.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: input.query,
          documents: input.documents.map((document) => document.text),
          top_n: input.documents.length,
          ...(this.instruct ? { instruct: this.instruct } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw Object.assign(
          new Error(`Cross-Encoder 请求失败: HTTP ${response.status} ${detail.slice(0, 300)}`),
          { status: response.status },
        );
      }

      const payload = await response.json() as unknown;
      return normalizeRerankResponse(payload, input.documents.length);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConfiguredCrossEncoderReranker(): CrossEncoderReranker | undefined {
  const url = process.env.RAG_RERANK_URL?.trim();
  const model = process.env.RAG_RERANK_MODEL?.trim();
  const apiKey = (
    process.env.RAG_RERANK_API_KEY
    || process.env.DASHSCOPE_API_KEY
  )?.trim();

  if (!url || !model || !apiKey) {
    return undefined;
  }

  return new HttpCrossEncoderReranker({
    url,
    model,
    apiKey,
  });
}

function normalizeRerankResponse(
  payload: unknown,
  expectedCount: number,
): CrossEncoderScore[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Cross-Encoder 返回格式错误');
  }

  const value = payload as {
    id?: unknown;
    model?: unknown;
    usage?: { total_tokens?: unknown };
    results?: unknown;
    output?: { results?: unknown };
  };
  const rawResults = Array.isArray(value.results)
    ? value.results
    : Array.isArray(value.output?.results)
      ? value.output.results
      : undefined;

  if (!rawResults) {
    throw new Error('Cross-Encoder 未返回 results 数组');
  }

  const seen = new Set<number>();
  const scores = rawResults.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Cross-Encoder result 格式错误');
    }
    const result = item as {
      index?: unknown;
      relevance_score?: unknown;
      score?: unknown;
    };
    const index = Number(result.index);
    const score = Number(result.relevance_score ?? result.score);

    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new Error(`Cross-Encoder index 越界: ${String(result.index)}`);
    }
    if (seen.has(index)) {
      throw new Error(`Cross-Encoder index 重复: ${index}`);
    }
    if (!Number.isFinite(score)) {
      throw new Error(`Cross-Encoder score 非法: ${String(result.relevance_score ?? result.score)}`);
    }
    seen.add(index);
    return {
      index,
      score: Math.max(0, Math.min(1, score)),
    };
  }) as CrossEncoderScores;
  const totalTokens = Number(value.usage?.total_tokens);
  Object.defineProperty(scores, 'providerResponse', {
    enumerable: false,
    value: {
      requestId: typeof value.id === 'string' ? value.id : undefined,
      model: typeof value.model === 'string' ? value.model : undefined,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : undefined,
    },
  });
  return scores;
}
