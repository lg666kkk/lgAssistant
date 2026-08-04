import { describe, expect, it } from "vitest";
import {
  deterministicWriteDecision,
  shouldRecallLongTermMemory,
} from "@/lib/agent/memory/memory-flow";
import {
  memoryIntegrationCases,
  memoryRecallGateCases,
  memoryWriteDecisionCases,
} from "./memory-recall-cases";

/**
 * 只跑 case 集里不需要外部依赖的那两类。
 * retrieval_quality / storage_semantics / fusion_ab 需要真实 Postgres + embedding
 * 服务，放在这里会让单测变成集成测试；它们以清单形式保留在 case 文件里，
 * 由带库的 eval 流程消费。下面最后一个 describe 保证那份清单不会悄悄腐烂。
 */
describe("记忆召回门控基线", () => {
  it.each(memoryRecallGateCases.map((c) => [c.id, c] as const))(
    "%s",
    (_id, testCase) => {
      expect(shouldRecallLongTermMemory(testCase.query), testCase.why).toBe(
        testCase.expectedEligible,
      );
    },
  );
});

describe("记忆写入判定基线", () => {
  it.each(memoryWriteDecisionCases.map((c) => [c.id, c] as const))(
    "%s",
    (_id, testCase) => {
      const decision = deterministicWriteDecision(testCase.fact, testCase.candidates);

      // 确定性分支返回 null = 交给模型判断。这类 case 的断言只能是
      // 「不会在没有把握时给出破坏性动作」，所以此处允许 null，
      // 但仅限期望动作里包含 NOOP 的那些（拒绝猜测本身就是期望结果）。
      if (decision === null) {
        expect(testCase.expectedActions, testCase.why).toContain("NOOP");
        return;
      }

      expect(testCase.expectedActions, testCase.why).toContain(decision.action);
      if (testCase.expectedTargetKey && "targetKey" in decision) {
        expect(decision.targetKey).toBe(testCase.expectedTargetKey);
      }
      if (testCase.expectedSupersedeKind && "supersedeKind" in decision) {
        expect(decision.supersedeKind).toBe(testCase.expectedSupersedeKind);
      }
    },
  );
});

describe("集成 case 清单的自检", () => {
  it("每条 known_red 都写明了被什么解除，否则无法区分「还没做」与「做完了但坏了」", () => {
    const badlyMarked = memoryIntegrationCases
      .filter((testCase) => testCase.expectation === "known_red" && !testCase.unblockedBy)
      .map((testCase) => testCase.id);
    expect(badlyMarked).toEqual([]);
  });

  it("专有名词 case 拆成数字 / Latin / 中文三条，不合并", () => {
    // 合并成一条中文样本会导致「关键词通道第一步无效」的错误结论：
    // 第一步只覆盖数字与 Latin token，中文本来就不该在这一步通过。
    const ids = memoryIntegrationCases.map((testCase) => testCase.id);
    expect(ids).toContain("retrieval-number-query");
    expect(ids).toContain("retrieval-latin-model");
    expect(ids).toContain("retrieval-chinese-rare-term");
  });

  it("融合对照必须跑满三组，含 vector-only 对照组", () => {
    const fusion = memoryIntegrationCases
      .filter((testCase) => testCase.kind === "fusion_ab")
      .map((testCase) => testCase.id);
    expect(fusion).toEqual([
      "fusion-ab-vector-only",
      "fusion-ab-weighted",
      "fusion-ab-rrf",
    ]);
  });

  it("A/B 集里必须有负例，否则一定会得出「融合全面变好」", () => {
    // 关键词通道天然倾向多召回。只跑正例时，噪声这一侧的代价完全不可见。
    const ab = memoryIntegrationCases.filter((testCase) => testCase.ab);
    expect(ab.some((testCase) => testCase.ab!.expectedKeys.length === 0)).toBe(true);
    expect(ab.some((testCase) => testCase.ab!.expectedKeys.length > 0)).toBe(true);
  });

  it("三条关键词专项 case 都能被跑分器读到（填了 ab 字段）", () => {
    // 少填一条，跑分器会静默跳过它，而报表看起来仍然「全绿」。
    const withAb = new Set(
      memoryIntegrationCases.filter((testCase) => testCase.ab).map((testCase) => testCase.id),
    );
    for (const id of [
      "retrieval-number-query",
      "retrieval-latin-model",
      "retrieval-chinese-rare-term",
    ]) {
      expect(withAb.has(id)).toBe(true);
    }
  });
});
