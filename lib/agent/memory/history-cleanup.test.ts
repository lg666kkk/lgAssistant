import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  resolveRetentionTiers,
} from "./history-cleanup";

/**
 * 保留期这套配置里，能悄悄造成不可恢复损失的只有两处：
 *   1. 环境变量写成 0 / -1 / 空 —— 若被接受，cutoff 变成「现在」，一次跑清空整张表。
 *   2. correction 档被并进短档 —— 系统会抹掉自己的误记录，
 *      而「你之前是不是记错了」只能靠这类行回答。
 */

const ENV_KEYS = [
  "MEMORY_HISTORY_RETENTION_DAYS_FACT",
  "MEMORY_HISTORY_RETENTION_DAYS_EPISODIC",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveRetentionTiers", () => {
  const now = Date.UTC(2026, 7, 4);

  it("按类型分档，profile / correction 留最久，episodic 最短", () => {
    const tiers = new Map(
      resolveRetentionTiers(now).map((tier) => [tier.memoryType, tier.retentionDays]),
    );

    expect(tiers.get("profile")).toBeGreaterThan(tiers.get("fact")!);
    expect(tiers.get("correction")).toBe(tiers.get("profile"));
    expect(tiers.get("episodic")).toBeLessThan(tiers.get("fact")!);
  });

  it("cutoff 是「现在减去保留天数」，按 superseded_at 比较", () => {
    const fact = resolveRetentionTiers(now).find((tier) => tier.memoryType === "fact")!;
    const expected = new Date(now - fact.retentionDays * 86_400_000).toISOString();
    expect(fact.cutoff).toBe(expected);
  });

  it("环境变量能逐档覆盖", () => {
    process.env.MEMORY_HISTORY_RETENTION_DAYS_FACT = "30";
    const fact = resolveRetentionTiers(now).find((tier) => tier.memoryType === "fact")!;
    expect(fact.retentionDays).toBe(30);
  });

  it("0 / 负数 / 非数字一律退回默认值，不能靠写错变量删光历史", () => {
    for (const bad of ["0", "-1", "", "abc", "NaN"]) {
      process.env.MEMORY_HISTORY_RETENTION_DAYS_EPISODIC = bad;
      const tier = resolveRetentionTiers(now).find(
        (item) => item.memoryType === "episodic",
      )!;
      expect(tier.retentionDays).toBe(DEFAULT_HISTORY_RETENTION_DAYS.episodic);
    }
  });

  it("有 default 档兜底，新增 memory_type 不会漏扫也不会被删得更狠", () => {
    const tiers = resolveRetentionTiers(now);
    const fallback = tiers.find((tier) => tier.memoryType === "default")!;
    const shortest = Math.min(...tiers.map((tier) => tier.retentionDays));
    expect(fallback).toBeDefined();
    expect(fallback.retentionDays).toBeGreaterThan(shortest);
  });
});
