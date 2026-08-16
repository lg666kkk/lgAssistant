import { describe, expect, it, vi } from "vitest";
import type { MemoryTimelineEntry } from "@/lib/agent/memory/history-store";
import type { MemoryRecord } from "@/lib/agent/memory/types";
import {
  createRecallMemoryTool,
  createSearchMemoryHistoryTool,
} from "./memory-recall";

/**
 * 这组断言的重点不是「工具能返回数据」，而是三件容易被悄悄改坏的事：
 *   1. 缺 userId 时一次查询都不发（service-role 绕过 RLS，应用层是唯一防线）。
 *   2. input_schema 里永远没有 userId 字段（有了模型就能越权读别人的记忆）。
 *   3. 时间线并进了当前行、误记打了标注（少任一条，模型会把过期值或误记讲给用户）。
 */

function timelineEntry(overrides: Partial<MemoryTimelineEntry> = {}): MemoryTimelineEntry {
  return {
    key: "budget:car",
    content: "用户的购车预算是 5 万",
    memoryType: "fact",
    source: "user_explicit",
    confidence: 0.9,
    version: 1,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: "2026-07-01T00:00:00.000Z",
    recordedAt: "2026-06-01T00:00:00.000Z",
    supersededAt: "2026-07-01T00:00:00.000Z",
    supersedeKind: "evolution",
    reason: null,
    isCurrent: false,
    neverEffective: false,
    ...overrides,
  };
}

function currentEntry(): MemoryTimelineEntry {
  return timelineEntry({
    content: "用户的购车预算是 8 万",
    version: 2,
    effectiveFrom: "2026-07-01T00:00:00.000Z",
    effectiveTo: null,
    recordedAt: "2026-07-01T00:00:00.000Z",
    supersededAt: null,
    supersedeKind: null,
    isCurrent: true,
  });
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    key: "budget:car",
    layer: "semantic",
    type: "fact",
    source: "user_explicit",
    confidence: 0.91,
    importance: 0.7,
    status: "active",
    content: "用户的购车预算是 8 万",
    evidence: null,
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    validFrom: "2026-07-01T00:00:00.000Z",
    validTo: null,
    lastAccessedAt: null,
    score: 0.91,
    ...overrides,
  };
}

// 替身的方法故意保留 vi.fn 的具体类型（而不是收敛成 MemoryHistoryReader），
// 这样断言里能直接用 .not.toHaveBeenCalled()。
function historyStub(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    resolveKeys: vi.fn(async () => [
      { key: "budget:car", content: "购车预算", status: "active", similarity: 0.8 },
    ]),
    recordedHistory: vi.fn(async () => [timelineEntry()]),
    truthAsOf: vi.fn(async () => [timelineEntry()]),
    currentEntry: vi.fn(async () => currentEntry()),
    ...overrides,
  };
}

describe("recall_memory", () => {
  it("声明了 requiresAuth，且 input_schema 里没有 userId 字段", () => {
    const tool = createRecallMemoryTool();
    expect(tool.runtime.requiresAuth).toBe(true);
    expect(Object.keys(tool.input_schema.properties ?? {})).not.toContain("userId");
    expect(tool.input_schema.additionalProperties).toBe(false);
    // memory 不复用 knowledge：否则 route 判定「不查知识库」会连记忆一起掐掉。
    expect(tool.outputPolicy.retrieval?.source).toBe("memory");
    // 记忆是抽取出来的推断，不是权威结果。
    expect(tool.outputPolicy.grounding).toBe("cited_evidence");
  });

  it("缺 userId 时立即拒绝，不触碰召回链路", async () => {
    const recall = vi.fn();
    const tool = createRecallMemoryTool({ recall: recall as never });

    const result = await tool.execute({ query: "购车预算" }, {});

    expect(result.ok).toBe(false);
    expect(recall).not.toHaveBeenCalled();
  });

  it("模型即使传了 userId 也不会被采用：userId 只从 context 取", async () => {
    const recall = vi.fn(async () => ({
      candidates: [], selected: [], limit: 3, threshold: 0.68,
    }));
    const tool = createRecallMemoryTool({ recall: recall as never });

    await tool.execute(
      { query: "购车预算", userId: "someone-else" },
      { userId: "u-1" },
    );

    expect(recall).toHaveBeenCalledWith("购车预算", { limit: 3, userId: "u-1" });
  });

  it("查到记忆时把内容标成候选背景数据，而不是已确认前提", async () => {
    const rerankTrace = {
      enabled: true,
      configured: true,
      mode: "always" as const,
      model: "qwen3-rerank",
      instruct: "Retrieve relevant memories.",
      candidateCount: 1,
      candidateLimit: 12,
      used: true,
      reason: "mode_always",
      latencyMs: 42,
      candidates: [{
        key: "budget:car",
        content: "联系 user@example.com",
        crossEncoderScore: 0.93,
      }],
    };
    const recall = vi.fn(async () => ({
      candidates: [memoryRecord()],
      selected: [memoryRecord()],
      limit: 3,
      threshold: 0.68,
      rerankTrace,
    }));
    const tool = createRecallMemoryTool({ recall: recall as never });

    const result = await tool.execute({ query: "购车预算" }, { userId: "u-1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("8 万");
    expect(result.content).toContain("候选背景数据");
    expect(result.content).not.toContain("budget:car");
    expect(result.content).not.toContain("user_explicit");
    expect(result.content).not.toContain("0.91");
    expect(result.metadata?.memoryKeys).toEqual(["budget:car"]);
    expect(result.metadata?.memoryRerank).toEqual({
      ...rerankTrace,
      candidates: [{
        key: "budget:car",
        content: "联系 [REDACTED_EMAIL]",
        crossEncoderScore: 0.93,
      }],
    });
  });

  it("没查到时明确说「查过了没有」，不留含糊空返回", async () => {
    const recall = vi.fn(async () => ({
      candidates: [], selected: [], limit: 3, threshold: 0.68,
    }));
    const tool = createRecallMemoryTool({ recall: recall as never });

    const result = await tool.execute({ query: "购车预算" }, { userId: "u-1" });

    // ok: true —— 「查过且为空」是有效结果，不是失败。
    // 报成失败会让模型重试同一次召回。
    expect(result.ok).toBe(true);
    expect(result.content).toContain("没有与该问题相关的记录");
    expect(result.metadata?.memorySelectedCount).toBe(0);
  });
});

describe("search_memory_history", () => {
  it("声明了 requiresAuth，且 input_schema 里没有 userId 字段", () => {
    const tool = createSearchMemoryHistoryTool();
    expect(tool.runtime.requiresAuth).toBe(true);
    expect(Object.keys(tool.input_schema.properties ?? {})).not.toContain("userId");
    expect(tool.outputPolicy.retrieval?.source).toBe("memory");
    // 历史表能证明「系统记录过什么」，不能证明「什么是真的」。
    expect(tool.outputPolicy.grounding).toBe("cited_evidence");
    // 没有 retrieval 预算等于模型可以无限翻历史。
    expect(tool.outputPolicy.retrieval?.maxCallsPerRun).toBeGreaterThan(0);
  });

  it("缺 userId 时一次查询都不发", async () => {
    const store = historyStub();
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute({ query: "购车预算" }, {});

    expect(result.ok).toBe(false);
    expect(store.resolveKeys).not.toHaveBeenCalled();
    expect(store.recordedHistory).not.toHaveBeenCalled();
    expect(store.currentEntry).not.toHaveBeenCalled();
  });

  it("时间线并进当前行，否则用户看到一条断尾的变化过程", async () => {
    const store = historyStub();
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute({ query: "购车预算" }, { userId: "u-1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("8 万"); // 当前值
    expect(result.content).toContain("5 万"); // 被取代的旧值
    expect(result.content).not.toContain("budget:car");
    expect(result.content).not.toContain("user_explicit");
    expect(result.metadata?.memoryHistoryCount).toBe(2);
    const timeline = (result.data as { timeline: MemoryTimelineEntry[] }).timeline;
    expect(timeline[0].isCurrent).toBe(true);
  });

  it("correction 条目必须标注「从未生效」", async () => {
    const store = historyStub({
      recordedHistory: vi.fn(async () => [
        timelineEntry({
          effectiveTo: "2026-06-01T00:00:00.000Z", // 与 effectiveFrom 相同 = 区间归零
          supersedeKind: "correction",
          neverEffective: true,
        }),
      ]),
    });
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute({ query: "购车预算" }, { userId: "u-1" });

    // 不标注的话，模型会把「系统曾记错成 5 万」复述成「你以前的预算是 5 万」。
    expect(result.content).toContain("从未生效");
    expect(result.metadata?.memoryHistoryCorrectionCount).toBe(1);
  });

  it("truth_as_of 缺 asOf 时拒绝，而不是兜底成现在", async () => {
    const store = historyStub();
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute(
      { query: "购车预算", mode: "truth_as_of" },
      { userId: "u-1" },
    );

    // 兜底成 NOW() 会让 truth_as_of 静默退化成 recall_memory，
    // 而模型以为自己查的是历史上某一时刻。
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Missing asOf");
    expect(store.truthAsOf).not.toHaveBeenCalled();
  });

  it("truth_as_of 走有效轴，且当前行覆盖该时刻时也算进去", async () => {
    const store = historyStub({
      truthAsOf: vi.fn(async () => []),
    });
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute(
      { query: "购车预算", mode: "truth_as_of", asOf: "2026-08-01T00:00:00.000Z" },
      { userId: "u-1" },
    );

    // 值在 2026-07-01 之后一直没变，历史表里没有覆盖 8 月的行；
    // 只查历史表会得出「那时没有任何记录」的错误结论。
    expect(store.truthAsOf).toHaveBeenCalledWith(
      "budget:car",
      "2026-08-01T00:00:00.000Z",
      { userId: "u-1" },
    );
    expect(result.metadata?.memoryHistoryCount).toBe(1);
    expect(result.content).toContain("8 万");
  });

  it("传了 key 就跳过语义解析", async () => {
    const store = historyStub();
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute(
      { query: "购车预算", key: "budget:car" },
      { userId: "u-1" },
    );

    expect(store.resolveKeys).not.toHaveBeenCalled();
    expect(result.content).not.toContain("budget:car");
    expect(result.metadata?.memoryHistoryKeyResolvedFrom).toBe("explicit_key");
  });

  it("解析不到 key 时如实说明可能已被删除，不报成故障", async () => {
    const store = historyStub({ resolveKeys: vi.fn(async () => []) });
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute({ query: "居住城市" }, { userId: "u-1" });

    // purge 过的 key 查不到是**正确行为**（4.6）。报成失败会让模型
    // 反复重试，甚至向用户声称系统出错。
    expect(result.ok).toBe(true);
    expect(result.content).toContain("删除");
    expect(store.currentEntry).not.toHaveBeenCalled();
  });

  it("asOf 不是可解析时间时拒绝，不把非法值传进 SQL", async () => {
    const store = historyStub();
    const tool = createSearchMemoryHistoryTool({ store });

    const result = await tool.execute(
      { query: "购车预算", mode: "truth_as_of", asOf: "去年" },
      { userId: "u-1" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid asOf");
    expect(store.truthAsOf).not.toHaveBeenCalled();
  });
});
