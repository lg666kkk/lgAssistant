import { describe, expect, it } from "vitest";
import { buildMemoryWriteCandidateTrace, consolidate } from "./memory-flow";
import { summarizeMemoryConsolidation } from "./observability";
import type { MemoryRecord } from "./types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    key: "profile:language",
    layer: "longterm",
    type: "preference",
    source: "user_explicit",
    confidence: 0.9,
    importance: 0.8,
    status: "active",
    content: "用户偏好中文",
    evidence: null,
    metadata: { writeAction: "ADD" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    lastAccessedAt: null,
    ...overrides,
  };
}

describe("memory observability", () => {
  it("reports per-fact candidate details and mutation authorization", () => {
    const exact = memory({ key: "profile:language", version: 2 });
    const semantic = memory({
      id: "memory-2",
      key: "preference:communication_style",
      content: "用户偏好中文回答",
      score: 0.83,
    });
    const trace = buildMemoryWriteCandidateTrace({
      fact: {
        fact: "用户偏好使用中文",
        key: "profile:language",
        type: "preference",
        source: "user_explicit",
        confidence: 0.98,
        importance: 0.8,
        evidenceExcerpt: "请一直用中文回答",
        intent: "upsert",
      },
      factIndex: 0,
      attempt: 1,
      candidates: [exact, semantic],
      groups: { exact: [exact], alias: [], semantic: [semantic] },
      mutationAuthorizedKeys: new Set([exact.key]),
    });

    expect(trace).toMatchObject({
      factKey: "profile:language",
      availableCounts: { exact: 1, alias: 0, semantic: 1 },
      selectedCount: 2,
      budgetTruncated: false,
      candidates: [
        { source: "exact", key: exact.key, mutationAuthorized: true },
        { source: "semantic", key: semantic.key, score: 0.83, mutationAuthorized: false },
      ],
    });
    expect(JSON.stringify(trace)).not.toContain("请一直用中文回答");
  });

  it("reports aggregate write data without exposing memory content", () => {
    const summary = summarizeMemoryConsolidation([
      memory(),
      memory({ id: "memory-2", type: "fact", metadata: { writeAction: "UPDATE" } }),
    ]);

    expect(summary).toEqual({
      persistedCount: 2,
      writeActions: { ADD: 1, UPDATE: 1 },
      memoryTypes: { preference: 1, fact: 1 },
      sources: { user_explicit: 2 },
    });
    expect(JSON.stringify(summary)).not.toContain("用户偏好中文");
  });

  it("reports an aggregate skip outcome without invoking external memory services", async () => {
    let outcome: unknown;

    await expect(consolidate([], {
      onOutcome: (result) => {
        outcome = result;
      },
    })).resolves.toEqual([]);

    expect(outcome).toEqual({
      status: "skipped",
      skipReason: "empty_conversation",
      extractedFactCount: 0,
      persistedCount: 0,
      invalidatedCount: 0,
      // 硬删除与软失效分开计数：前者不可恢复，运维上不能混在一个数字里。
      purgedCount: 0,
      skippedCount: 0,
      // 版本冲突重试次数，用来观测固化并发是否真的在发生。
      retriedCount: 0,
      failedCount: 0,
      decisions: {},
      candidateDetails: [],
    });
  });
});
