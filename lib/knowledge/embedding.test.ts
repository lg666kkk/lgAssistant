import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingClient,
  type EmbeddingBatchEvent,
  type EmbeddingProviderRequest,
  type EmbeddingProviderRequestOptions,
  validateEmbeddingVector,
} from './embedding';

function vector(value: number) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

describe('EmbeddingClient batch integrity', () => {
  it('reorders each provider batch by index and preserves global input order', async () => {
    const events: EmbeddingBatchEvent[] = [];
    const create = vi.fn(
      async (
        request: EmbeddingProviderRequest,
        _options: EmbeddingProviderRequestOptions,
      ) => {
        if (request.input.length === 2) {
          return {
            data: [
              { index: 1, embedding: vector(2) },
              { index: 0, embedding: vector(1) },
            ],
            usage: { promptTokens: 5, totalTokens: 5 },
          };
        }
        return {
          data: [{ index: 0, embedding: vector(3) }],
          usage: { promptTokens: 3, totalTokens: 3 },
        };
      },
    );
    const client = new EmbeddingClient({
      provider: { create },
      batchSize: 2,
      maxRetries: 0,
    });

    const embeddings = await client.embedBatch(['first', 'second', 'third'], {
      idempotencyScope: 'page-1',
      onEvent: (event) => events.push(event),
    });

    expect(embeddings.map((embedding) => embedding[0])).toEqual([1, 2, 3]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].input).toEqual(['first', 'second']);
    expect(create.mock.calls[1][0].input).toEqual(['third']);
    expect(create.mock.calls[0][1].maxRetries).toBe(0);
    expect(create.mock.calls[0][1].headers['Idempotency-Key']).toMatch(
      /^embedding-[a-f0-9]{64}$/,
    );
    expect(create.mock.calls[0][1].headers['Idempotency-Key']).not.toBe(
      create.mock.calls[1][1].headers['Idempotency-Key'],
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'batch_done',
        batchIndex: 1,
        providerIndexes: [1, 0],
        reordered: true,
        inputTokens: 5,
        totalTokens: 5,
      }),
    );
  });

  it('retries a partial response with the same idempotency key', async () => {
    const events: EmbeddingBatchEvent[] = [];
    const sleep = vi.fn(async (_ms: number) => undefined);
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ index: 0, embedding: vector(1) }],
      })
      .mockResolvedValueOnce({
        data: [
          { index: 1, embedding: vector(2) },
          { index: 0, embedding: vector(1) },
        ],
      });
    const client = new EmbeddingClient({
      provider: { create },
      batchSize: 2,
      maxRetries: 2,
      retryBaseDelayMs: 25,
      sleep,
    });

    const embeddings = await client.embedBatch(['first', 'second'], {
      idempotencyScope: 'page-1',
      onEvent: (event) => events.push(event),
    });

    expect(embeddings.map((embedding) => embedding[0])).toEqual([1, 2]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(create.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      create.mock.calls[1][1].headers['Idempotency-Key'],
    );
    expect(events.map((event) => event.type)).toEqual([
      'batch_start',
      'batch_retry',
      'batch_done',
    ]);
    expect(events[1]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      nextDelayMs: 25,
      retryable: true,
    });
  });

  it('does not retry a non-retryable provider error', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
    const create = vi.fn().mockRejectedValue(unauthorized);
    const client = new EmbeddingClient({
      provider: { create },
      maxRetries: 2,
      sleep,
    });

    await expect(client.embedBatch(['first'])).rejects.toThrow('unauthorized');
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not treat a completion observer error as a provider retry', async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: vector(1) }],
    });
    const client = new EmbeddingClient({
      provider: { create },
      maxRetries: 2,
    });

    await expect(
      client.embedBatch(['first'], {
        onEvent: (event) => {
          if (event.type === 'batch_done') {
            throw new Error('observer failed');
          }
        },
      }),
    ).rejects.toThrow('observer failed');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails after the retry budget when partial responses persist', async () => {
    const events: EmbeddingBatchEvent[] = [];
    const sleep = vi.fn(async (_ms: number) => undefined);
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: vector(1) }],
    });
    const client = new EmbeddingClient({
      provider: { create },
      batchSize: 2,
      maxRetries: 2,
      retryBaseDelayMs: 10,
      sleep,
    });

    await expect(
      client.embedBatch(['first', 'second'], {
        idempotencyScope: 'page-1',
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('provider 返回数量不一致');

    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
    expect(new Set(
      create.mock.calls.map((call) => call[1].headers['Idempotency-Key']),
    ).size).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: 'batch_failed',
      attempt: 3,
      maxAttempts: 3,
      retryable: true,
    });
  });

  it.each([
    {
      name: 'missing provider index',
      data: [
        { index: 0, embedding: vector(1) },
        { index: undefined as unknown as number, embedding: vector(2) },
      ],
      error: 'provider index 缺失或不是整数',
    },
    {
      name: 'duplicate provider index',
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
      error: 'provider index 重复',
    },
    {
      name: 'out-of-range provider index',
      data: [
        { index: 0, embedding: vector(1) },
        { index: 2, embedding: vector(2) },
      ],
      error: 'provider index 越界',
    },
  ])('rejects $name', async ({ data, error }) => {
    const create = vi.fn().mockResolvedValue({ data });
    const client = new EmbeddingClient({
      provider: { create },
      batchSize: 2,
      maxRetries: 0,
    });

    await expect(client.embedBatch(['first', 'second'])).rejects.toThrow(error);
  });
});

describe('validateEmbeddingVector', () => {
  it('rejects empty, malformed, non-finite, and zero vectors', () => {
    expect(() => validateEmbeddingVector([], 'test')).toThrow('为空向量');
    expect(() => validateEmbeddingVector([0.1], 'test')).toThrow('向量维度错误');

    const nonFinite = vector(0.1);
    nonFinite[8] = Number.NaN;
    expect(() => validateEmbeddingVector(nonFinite, 'test')).toThrow('向量包含非有限数');

    const infinite = vector(0.1);
    infinite[8] = Number.POSITIVE_INFINITY;
    expect(() => validateEmbeddingVector(infinite, 'test')).toThrow('向量包含非有限数');
    expect(() => validateEmbeddingVector(vector(0), 'test')).toThrow('为零向量');
  });
});
