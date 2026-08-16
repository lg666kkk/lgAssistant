import { describe, expect, it, vi } from 'vitest';
import { HttpCrossEncoderReranker } from './reranker';

describe('HttpCrossEncoderReranker', () => {
  it('supports DashScope-style output and normalizes scores', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      output: {
        results: [
          { index: 1, relevance_score: 1.2 },
          { index: 0, relevance_score: 0.2 },
        ],
      },
    }), { status: 200 }));
    const reranker = new HttpCrossEncoderReranker({
      url: 'https://example.com/rerank',
      apiKey: 'test-key',
      model: 'test-reranker',
      fetchImpl,
    });

    const scores = await reranker.rerank({
      query: 'RAG',
      documents: [
        { id: 'a', text: 'doc a' },
        { id: 'b', text: 'doc b' },
      ],
    });

    expect(scores).toEqual([
      { index: 1, score: 1 },
      { index: 0, score: 0.2 },
    ]);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      model: 'test-reranker',
      query: 'RAG',
      documents: ['doc a', 'doc b'],
      top_n: 2,
    });
  });

  it('builds the Bailian compatible request used by qwen3-rerank', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      object: 'list',
      results: [{ index: 0, relevance_score: 0.9 }],
      model: 'qwen3-rerank',
      id: 'request-123',
      usage: { total_tokens: 42 },
    }), { status: 200 }));
    const reranker = new HttpCrossEncoderReranker({
      url: 'https://example.com/qwen-rerank',
      apiKey: 'test-key',
      model: 'qwen3-rerank',
      instruct: 'Retrieve relevant personal memories.',
      fetchImpl,
    });

    const scores = await reranker.rerank({
      query: '用户的预算',
      documents: [{ id: 'a', text: '用户的购车预算是 8 万' }],
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request).toEqual({
      model: 'qwen3-rerank',
      query: '用户的预算',
      documents: ['用户的购车预算是 8 万'],
      top_n: 1,
      instruct: 'Retrieve relevant personal memories.',
    });
    expect(scores.providerResponse).toEqual({
      requestId: 'request-123',
      model: 'qwen3-rerank',
      totalTokens: 42,
    });
  });

  it('rejects duplicate indexes', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.8 },
        { index: 0, relevance_score: 0.7 },
      ],
    }), { status: 200 }));
    const reranker = new HttpCrossEncoderReranker({
      url: 'https://example.com/rerank',
      apiKey: 'test-key',
      model: 'test-reranker',
      fetchImpl,
    });

    await expect(reranker.rerank({
      query: 'RAG',
      documents: [
        { id: 'a', text: 'doc a' },
        { id: 'b', text: 'doc b' },
      ],
    })).rejects.toThrow('index 重复');
  });
});
