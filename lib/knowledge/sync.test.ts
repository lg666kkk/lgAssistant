import { describe, expect, it } from "vitest";
import type { TextChunk } from "./chunking";
import { buildAtomicDocumentPayload, buildParentContext } from "./sync";

const chunk: TextChunk = {
  text: "RAG 使用检索证据增强回答。",
  index: 0,
  startChar: 0,
  endChar: 15,
  headingPath: ["RAG"],
};

function embedding(value = 0.01) {
  return Array.from({ length: 1024 }, () => value);
}

describe("RAG atomic sync payload", () => {
  it("builds a complete document payload before the transaction", () => {
    const payload = buildAtomicDocumentPayload({
      chunks: [chunk],
      embeddings: [embedding()],
      pageId: "page-1",
      pageTitle: "RAG 设计",
      pageUrl: "https://example.com/rag",
      lastEditedTime: "2026-07-17T00:00:00.000Z",
    });

    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      chunk_index: 0,
      content: chunk.text,
      metadata: {
        page_id: "page-1",
        page_title: "RAG 设计",
        heading_path: ["RAG"],
        embedding_model: "text-embedding-v4",
      },
    });
    expect(payload[0].embedding).toHaveLength(1024);
  });

  it("rejects a partial embedding response before replacing old chunks", () => {
    expect(() =>
      buildAtomicDocumentPayload({
        chunks: [chunk],
        embeddings: [],
        pageId: "page-1",
        pageTitle: "RAG 设计",
        pageUrl: "https://example.com/rag",
        lastEditedTime: "2026-07-17T00:00:00.000Z",
      }),
    ).toThrow("向量数量与 chunk 数量不一致");
  });

  it("rejects invalid vector dimensions, non-finite values, and zero vectors", () => {
    const base = {
      chunks: [chunk],
      pageId: "page-1",
      pageTitle: "RAG 设计",
      pageUrl: "https://example.com/rag",
      lastEditedTime: "2026-07-17T00:00:00.000Z",
    };

    expect(() =>
      buildAtomicDocumentPayload({
        ...base,
        embeddings: [[0.1, 0.2]],
      }),
    ).toThrow("向量维度错误");

    const invalidEmbedding = embedding();
    invalidEmbedding[10] = Number.NaN;
    expect(() =>
      buildAtomicDocumentPayload({
        ...base,
        embeddings: [invalidEmbedding],
      }),
    ).toThrow("向量包含非有限数");

    expect(() =>
      buildAtomicDocumentPayload({
        ...base,
        embeddings: [embedding(0)],
      }),
    ).toThrow("为零向量");
  });
});

describe("RAG parent context", () => {
  it("expands around the child within the same heading only", () => {
    const chunks: TextChunk[] = [
      { ...chunk, text: "第一段", index: 0, startChar: 0, endChar: 3 },
      { ...chunk, text: "第二段", index: 1, startChar: 4, endChar: 7 },
      {
        ...chunk,
        text: "其他章节",
        index: 2,
        startChar: 8,
        endChar: 12,
        headingPath: ["其他"],
      },
    ];

    const parent = buildParentContext(chunks, 1, "page-1", 100);

    expect(parent.content).toBe("第一段\n\n第二段");
    expect(parent.key).toBe("page-1:0:7");
    expect(parent.childCount).toBe(2);
  });
});
