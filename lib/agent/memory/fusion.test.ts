import { describe, expect, it } from "vitest";
import { admitFusedMemories, fuseMemoryChannels } from "./fusion";
import type { MemoryRecord } from "./types";

/**
 * 融合器的三条不能破的纪律：
 *   1. 合并是**并集**。取交集会把关键词通道的收益反向抵消（中文常见词经常空手而归）。
 *   2. 准入看**通道原始分**，排序看融合分。反过来的话，开启融合等于顺手抬高了
 *      召回门槛，而且没有任何测试会失败，只是记忆悄悄变少。
 *   3. vector_only 是真的对照组，不能偷看关键词结果 —— 否则 A/B 结论不可证伪。
 */

function record(key: string, score: number, content = key): MemoryRecord {
  return {
    id: `mem-${key}`,
    key,
    layer: "semantic",
    type: "fact",
    source: "user_explicit",
    confidence: 0.9,
    importance: 0.6,
    status: "active",
    content,
    evidence: null,
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    validFrom: "2026-07-01T00:00:00.000Z",
    validTo: null,
    lastAccessedAt: null,
    score,
  };
}

function byKey(hits: ReturnType<typeof fuseMemoryChannels>) {
  return new Map(hits.map((hit) => [hit.record.key, hit]));
}

describe("fuseMemoryChannels", () => {
  it("合并是并集：只进一条通道的条目也留下", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.82)],
      keyword: [record("budget:housing", 1)],
      strategy: "weighted",
    });

    expect(hits.map((hit) => hit.record.key).sort()).toEqual([
      "budget:car",
      "budget:housing",
    ]);
  });

  it("两个通道都命中同一条时合并成一条，原始分各自保留", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.82)],
      keyword: [record("budget:car", 0.5)],
      strategy: "weighted",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].vectorScore).toBe(0.82);
    expect(hits[0].keywordScore).toBe(0.5);
    expect(hits[0].channels.sort()).toEqual(["keyword", "vector"]);
  });

  it("两通道都命中的条目排在只命中一路的前面 —— 这就是融合的收益", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:housing", 0.84), record("budget:car", 0.80)],
      keyword: [record("budget:car", 1)],
      strategy: "weighted",
    });
    const map = byKey(hits);

    expect(map.get("budget:car")!.fusedScore).toBeGreaterThan(
      map.get("budget:housing")!.fusedScore,
    );
  });

  it("record.score 被换成融合分：下游 rankMemoryHits 按 score 排序", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.82)],
      keyword: [record("budget:car", 1)],
      strategy: "weighted",
    });

    expect(hits[0].record.score).toBe(hits[0].fusedScore);
    expect(hits[0].record.score).not.toBe(0.82);
  });

  it("vector_only 完全不看关键词结果 —— 对照组不能偷偷用另一路", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.82)],
      keyword: [record("budget:housing", 1)],
      strategy: "vector_only",
    });

    expect(hits.map((hit) => hit.record.key)).toEqual(["budget:car"]);
    // 融合分就是原始相似度，不做任何校准。
    expect(hits[0].fusedScore).toBe(0.82);
    expect(hits[0].keywordScore).toBe(0);
  });

  it("关键词全空时，weighted 的排序与纯向量单调等价", () => {
    const vector = [record("a", 0.9), record("b", 0.8), record("c", 0.7)];
    const fused = fuseMemoryChannels({ vector, keyword: [], strategy: "weighted" });

    const order = [...fused].sort((x, y) => y.fusedScore - x.fusedScore);
    expect(order.map((hit) => hit.record.key)).toEqual(["a", "b", "c"]);
  });

  it("rrf 分数被归一到 0~1，才能与 selectThreshold 同量纲比较", () => {
    const hits = fuseMemoryChannels({
      vector: [record("a", 0.9), record("b", 0.8)],
      keyword: [record("a", 1)],
      strategy: "rrf",
    });
    const map = byKey(hits);

    for (const hit of hits) {
      expect(hit.fusedScore).toBeGreaterThan(0);
      expect(hit.fusedScore).toBeLessThanOrEqual(1);
    }
    // 两路都排第 1 的条目拿到满分。
    expect(map.get("a")!.fusedScore).toBe(1);
    expect(map.get("b")!.fusedScore).toBeLessThan(1);
  });

  it("两条通道都空时返回空数组，不抛也不产生 NaN", () => {
    expect(fuseMemoryChannels({ vector: [], keyword: [], strategy: "rrf" })).toEqual([]);
  });
});

describe("admitFusedMemories", () => {
  const options = { selectThreshold: 0.68, keywordAdmitThreshold: 0.5 };

  it("向量分够高但融合分被拉低的条目仍然准入", () => {
    // weighted 下，关键词没命中时融合分约为 0.7 × 校准向量分：
    // 一条 0.75 的记忆融合后掉到 0.5 出头。按融合分判就会被丢掉。
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.75)],
      keyword: [],
      strategy: "weighted",
    });

    expect(hits[0].fusedScore).toBeLessThan(options.selectThreshold);
    expect(admitFusedMemories(hits, options)).toHaveLength(1);
  });

  it("向量分不够但关键词强命中的条目被救回来 —— 数字类问题靠这条", () => {
    const hits = fuseMemoryChannels({
      vector: [],
      keyword: [record("budget:car", 1)],
      strategy: "weighted",
    });

    expect(admitFusedMemories(hits, options)).toHaveLength(1);
  });

  it("两个原始分都不够的条目被挡掉", () => {
    const hits = fuseMemoryChannels({
      vector: [record("budget:car", 0.5)],
      keyword: [record("budget:car", 0.25)],
      strategy: "weighted",
    });

    expect(admitFusedMemories(hits, options)).toEqual([]);
  });
});
