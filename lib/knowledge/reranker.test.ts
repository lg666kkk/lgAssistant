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
