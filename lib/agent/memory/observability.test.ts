import { describe, expect, it } from "vitest";
import { consolidate } from "./memory-flow";
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
      skippedCount: 0,
      failedCount: 0,
      decisions: {},
    });
  });
});
