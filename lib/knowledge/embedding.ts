/**
 * Embedding 向量模型模块
 * 用于将文本转换为向量，支持语义检索
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { createSafeProviderFetch } from '@/lib/llm/url-safety';

export const EMBEDDING_MODEL = 'text-embedding-v4';
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_BATCH_SIZE = 10;
export const EMBEDDING_MAX_RETRIES = 2;

const EMBEDDING_RETRY_BASE_DELAY_MS = 500;

export type EmbeddingProviderRequest = {
  model: string;
  input: string[];
};

export type EmbeddingProviderRequestOptions = {
  headers: Record<string, string>;
  maxRetries: number;
};

export type EmbeddingProviderResponse = {
  data: Array<{
    index: number;
    embedding: unknown;
  }>;
  usage?: {
    promptTokens?: number;
    totalTokens?: number;
  };
};

export type EmbeddingUsage = {
  model: string;
  inputPriceCnyPerMillionTokens?: number;
  inputTokens: number;
  totalTokens: number;
  modelCallCount: number;
};

export type EmbeddingProvider = {
  create(
    request: EmbeddingProviderRequest,
    options: EmbeddingProviderRequestOptions,
  ): Promise<EmbeddingProviderResponse>;
};

export type EmbeddingBatchEvent = {
  type: 'batch_start' | 'batch_retry' | 'batch_done' | 'batch_failed';
  batchIndex: number;
  totalBatches: number;
  inputStart: number;
  inputCount: number;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  providerIndexes?: number[];
  reordered?: boolean;
  nextDelayMs?: number;
  retryable?: boolean;
  error?: string;
  inputTokens?: number;
  totalTokens?: number;
};

export type EmbedBatchOptions = {
  idempotencyScope?: string;
  onEvent?: (event: EmbeddingBatchEvent) => void;
};

export type EmbeddingClientOptions = {
  provider?: EmbeddingProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class EmbeddingIntegrityError extends Error {
  readonly code = 'EMBEDDING_INTEGRITY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingIntegrityError';
  }
}

/**
 * Embedding 客户端类
 * 封装了向量生成的所有操作
 */
export class EmbeddingClient {
  private provider: EmbeddingProvider;
  private model: string;
  private dimensions: number;
  private batchSize: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(options: EmbeddingClientOptions = {}) {
    this.provider = options.provider ?? createOpenAICompatibleProvider({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
    this.model = options.model ?? EMBEDDING_MODEL;
    this.dimensions = positiveInteger(
      options.dimensions ?? EMBEDDING_DIMENSIONS,
      'dimensions',
    );
    this.batchSize = positiveInteger(options.batchSize ?? EMBEDDING_BATCH_SIZE, 'batchSize');
    this.maxRetries = nonNegativeInteger(
      options.maxRetries ?? EMBEDDING_MAX_RETRIES,
      'maxRetries',
    );
    this.retryBaseDelayMs = nonNegativeInteger(
      options.retryBaseDelayMs ?? EMBEDDING_RETRY_BASE_DELAY_MS,
      'retryBaseDelayMs',
    );
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * 为单条文本生成向量
   * @param text 文本内容
   * @returns 1024 维向量数组
   */
  async embedSingle(
    text: string,
    options: EmbedBatchOptions = {},
  ): Promise<number[]> {
    const embeddings = await this.embedBatch([text], options);
    return embeddings[0];
  }

  /**
   * 为多条文本分批生成向量。每批按 provider index 重排并完整校验。
   * @param texts 文本数组
   * @returns 与输入顺序严格一致的向量数组
   */
  async embedBatch(
    texts: string[],
    options: EmbedBatchOptions = {},
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    validateEmbeddingInputs(texts);

    const totalBatches = Math.ceil(texts.length / this.batchSize);
    const embeddings: number[][] = [];

    for (let inputStart = 0; inputStart < texts.length; inputStart += this.batchSize) {
      const batchTexts = texts.slice(inputStart, inputStart + this.batchSize);
      const batchIndex = Math.floor(inputStart / this.batchSize) + 1;
      const idempotencyKey = buildEmbeddingIdempotencyKey({
        model: this.model,
        scope: options.idempotencyScope,
        texts: batchTexts,
      });
      const batchEmbeddings = await this.embedBatchWithRetry({
        batchTexts,
        batchIndex,
        totalBatches,
        inputStart,
        idempotencyKey,
        onEvent: options.onEvent,
      });
      embeddings.push(...batchEmbeddings);
    }

    if (embeddings.length !== texts.length) {
      throw new EmbeddingIntegrityError(
        `批量向量数量不一致: ${embeddings.length}/${texts.length}`,
      );
    }

    return embeddings;
  }

  private async embedBatchWithRetry(input: {
    batchTexts: string[];
    batchIndex: number;
    totalBatches: number;
    inputStart: number;
    idempotencyKey: string;
    onEvent?: (event: EmbeddingBatchEvent) => void;
  }): Promise<number[][]> {
    const maxAttempts = this.maxRetries + 1;

    input.onEvent?.({
      type: 'batch_start',
      batchIndex: input.batchIndex,
      totalBatches: input.totalBatches,
      inputStart: input.inputStart,
      inputCount: input.batchTexts.length,
      attempt: 1,
      maxAttempts,
      idempotencyKey: input.idempotencyKey,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let normalized: ReturnType<typeof normalizeEmbeddingResponse>;
      try {
        const response = await this.provider.create(
          {
            model: this.model,
            input: input.batchTexts,
          },
          {
            headers: {
              'Idempotency-Key': input.idempotencyKey,
            },
            maxRetries: 0,
          },
        );
        normalized = normalizeEmbeddingResponse(
          response,
          input.batchTexts.length,
          this.dimensions,
        );
      } catch (error) {
        const retryable = isRetryableEmbeddingError(error);
        if (!retryable || attempt >= maxAttempts) {
          input.onEvent?.({
            type: 'batch_failed',
            batchIndex: input.batchIndex,
            totalBatches: input.totalBatches,
            inputStart: input.inputStart,
            inputCount: input.batchTexts.length,
            attempt,
            maxAttempts,
            idempotencyKey: input.idempotencyKey,
            retryable,
            error: errorMessage(error),
          });
          throw batchError(input, attempt, error);
        }

        const nextDelayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
        input.onEvent?.({
          type: 'batch_retry',
          batchIndex: input.batchIndex,
          totalBatches: input.totalBatches,
          inputStart: input.inputStart,
          inputCount: input.batchTexts.length,
          attempt,
          maxAttempts,
          idempotencyKey: input.idempotencyKey,
          nextDelayMs,
          retryable,
          error: errorMessage(error),
        });
        await this.sleep(nextDelayMs);
        continue;
      }

      input.onEvent?.({
        type: 'batch_done',
        batchIndex: input.batchIndex,
        totalBatches: input.totalBatches,
        inputStart: input.inputStart,
        inputCount: input.batchTexts.length,
        attempt,
        maxAttempts,
        idempotencyKey: input.idempotencyKey,
        providerIndexes: normalized.providerIndexes,
        reordered: normalized.reordered,
        inputTokens: normalized.inputTokens,
        totalTokens: normalized.totalTokens,
      });

      return normalized.embeddings;
    }

    throw new Error('Embedding 批次重试状态异常');
  }
}

export function validateEmbeddingVector(
  embedding: unknown,
  label = 'Embedding',
  expectedDimensions = EMBEDDING_DIMENSIONS,
): asserts embedding is number[] {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new EmbeddingIntegrityError(`${label} 为空向量`);
  }
  if (embedding.length !== expectedDimensions) {
    throw new EmbeddingIntegrityError(
      `${label} 向量维度错误: ${embedding.length}/${expectedDimensions}`,
    );
  }

  let hasNonZeroValue = false;
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EmbeddingIntegrityError(`${label} 向量包含非有限数`);
    }
    if (value !== 0) {
      hasNonZeroValue = true;
    }
  }

  if (!hasNonZeroValue) {
    throw new EmbeddingIntegrityError(`${label} 为零向量`);
  }
}

function createOpenAICompatibleProvider(input: {
  apiKey?: string;
  baseUrl?: string;
}): EmbeddingProvider {
  const apiKey = input.apiKey?.trim();
  const baseURL = input.baseUrl?.trim();
  if (!apiKey) {
    throw new Error('缺少用户向量嵌入 API Key');
  }
  if (!baseURL) {
    throw new Error('缺少用户向量嵌入 Base URL');
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,
    fetch: createSafeProviderFetch(baseURL, 30_000),
  });

  return {
    async create(request, options) {
      const response = await client.embeddings.create(request, {
        headers: options.headers,
        maxRetries: options.maxRetries,
      });
      return {
        data: response.data.map((item) => ({
          index: item.index,
          embedding: item.embedding,
        })),
        usage: {
          promptTokens: response.usage?.prompt_tokens,
          totalTokens: response.usage?.total_tokens,
        },
      };
    },
  };
}

function normalizeEmbeddingResponse(
  response: EmbeddingProviderResponse,
  expectedCount: number,
  expectedDimensions = EMBEDDING_DIMENSIONS,
): {
  embeddings: number[][];
  providerIndexes: number[];
  reordered: boolean;
  inputTokens: number;
  totalTokens: number;
} {
  if (!response || !Array.isArray(response.data)) {
    throw new EmbeddingIntegrityError('provider 未返回 embedding data 数组');
  }
  if (response.data.length !== expectedCount) {
    throw new EmbeddingIntegrityError(
      `provider 返回数量不一致: ${response.data.length}/${expectedCount}`,
    );
  }

  const ordered = new Array<number[] | undefined>(expectedCount);
  const providerIndexes: number[] = [];

  for (const item of response.data) {
    const providerIndex = item?.index;
    if (!Number.isInteger(providerIndex)) {
      throw new EmbeddingIntegrityError('provider index 缺失或不是整数');
    }
    if (providerIndex < 0 || providerIndex >= expectedCount) {
      throw new EmbeddingIntegrityError(
        `provider index 越界: ${providerIndex}/${expectedCount}`,
      );
    }
    if (ordered[providerIndex]) {
      throw new EmbeddingIntegrityError(`provider index 重复: ${providerIndex}`);
    }

    validateEmbeddingVector(
      item.embedding,
      `provider index ${providerIndex}`,
      expectedDimensions,
    );
    ordered[providerIndex] = item.embedding;
    providerIndexes.push(providerIndex);
  }

  const embeddings = ordered.map((embedding, index) => {
    if (!embedding) {
      throw new EmbeddingIntegrityError(`provider index 缺失: ${index}`);
    }
    return embedding;
  });

  return {
    embeddings,
    providerIndexes,
    reordered: providerIndexes.some((providerIndex, index) => providerIndex !== index),
    inputTokens: nonNegativeUsageToken(response.usage?.promptTokens),
    totalTokens: nonNegativeUsageToken(
      response.usage?.totalTokens ?? response.usage?.promptTokens,
    ),
  };
}

function nonNegativeUsageToken(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function validateEmbeddingInputs(texts: string[]) {
  for (let index = 0; index < texts.length; index++) {
    if (typeof texts[index] !== 'string' || texts[index].trim().length === 0) {
      throw new Error(`Embedding 输入 #${index} 为空`);
    }
  }
}

function buildEmbeddingIdempotencyKey(input: {
  model: string;
  scope?: string;
  texts: string[];
}) {
  const hash = createHash('sha256');
  hash.update(input.model);
  hash.update('\0');
  hash.update(input.scope ?? '');
  for (const text of input.texts) {
    hash.update('\0');
    hash.update(text);
  }
  return `embedding-${hash.digest('hex')}`;
}

function isRetryableEmbeddingError(error: unknown) {
  if (error instanceof EmbeddingIntegrityError) {
    return true;
  }

  const status = errorStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  return true;
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function batchError(
  input: {
    batchIndex: number;
    totalBatches: number;
    idempotencyKey: string;
  },
  attempt: number,
  cause: unknown,
) {
  const error = new Error(
    `Embedding 批次 ${input.batchIndex}/${input.totalBatches} 失败（attempt=${attempt}, key=${input.idempotencyKey}）: ${errorMessage(cause)}`,
  ) as Error & { cause?: unknown; code?: string; status?: number };
  error.name = 'EmbeddingBatchError';
  error.code = 'EMBEDDING_BATCH_FAILED';
  error.cause = cause;
  error.status = errorStatus(cause);
  return error;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return value;
}

/**
 * 计算两个向量的余弦相似度
 * @param a 向量 A
 * @param b 向量 B
 * @returns 相似度分数 (0-1)，越接近 1 越相似
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
