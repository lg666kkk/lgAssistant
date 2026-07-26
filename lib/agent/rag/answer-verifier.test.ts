import { describe, expect, it } from "vitest";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
} from "./types";
import { verifyGroundedAnswer } from "./answer-verifier";

function bundle(): EvidenceBundle {
  return {
    bundleId: "evidence-test",
    version: AGENTIC_RAG_VERSION,
    route: "knowledge",
    query: "RAG 如何生成回答",
    indexVersion: "index-test",
    generatedAt: "2026-07-17T00:00:00.000Z",
    evidences: [{
      evidenceId: "ev_aaaaaaaaaaaa",
      source: "knowledge",
      chunkId: "chunk-1",
      documentId: "doc-1",
      documentVersion: "v1",
      title: "RAG 流程",
      content: "RAG 会先检索相关证据片段，再基于证据生成回答。",
      scores: { rerank: 0.8 },
      trustLevel: "private_user_content",
      citation: { url: "https://example.com/rag", startChar: 0, endChar: 24 },
    }],
    grade: {
      sufficient: true,
      grade: "strong",
      reason: "strong_single_evidence",
      topScore: 0.8,
      scoreGap: null,
      queryCoverage: 1,
      acceptedEvidenceIds: ["ev_aaaaaaaaaaaa"],
    },
    attempts: [],
  };
}

describe("claim-level groundedness verifier", () => {
  it("accepts a supported claim with a citation after punctuation", () => {
    const report = verifyGroundedAnswer(
      "RAG 会先检索相关证据片段，再基于证据生成回答。[ev_aaaaaaaaaaaa]",
      [bundle()],
    );

    expect(report).toMatchObject({
      status: "pass",
      claimCount: 1,
      citedClaimCount: 1,
      supportedClaimCount: 1,
      citationPrecision: 1,
      citationCoverage: 1,
      groundedness: 1,
    });
  });

  it("fails unknown citations", () => {
    const report = verifyGroundedAnswer(
      "RAG 会先检索相关证据。[ev_bbbbbbbbbbbb]",
      [bundle()],
    );

    expect(report.status).toBe("fail");
    expect(report.unknownCitationIds).toEqual(["ev_bbbbbbbbbbbb"]);
  });

  it("reports incomplete claim coverage without defining an output action", () => {
    const answer = [
      "RAG 会先检索相关证据片段。[ev_aaaaaaaaaaaa]",
      "这个方案在所有场景中成本都最低。",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.status).toBe("warn");
    expect(report.citationCoverage).toBe(0.5);
  });

  // 结构化排版曾经是 coverage 的最大杀手：标题、流程图、层级树、标签行都会被
  // 按行切成 claim，让一篇几乎句句有据的长回答掉到 0.17。
  it("keeps headings, diagrams and label rows out of the scored denominator", () => {
    const answer = [
      "一、RAG 的检索流程",
      "检索 → 排序 → 生成",
      "├── 检索器",
      "基础层：向量库",
      "RAG 会先检索相关证据片段，再基于证据生成回答。[ev_aaaaaaaaaaaa]",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.claimCount).toBe(1);
    expect(report.status).toBe("pass");
  });

  // 模型按 EVIDENCE_CITATION_POLICY 在一节的主句上写引用，随后展开的细节句
  // 不再重复引用。同节内能被该证据词面支撑的句子应当算作已溯源。
  it("lets a claim inherit a citation from the same section when the evidence supports it", () => {
    const answer = [
      "二、RAG",
      "RAG 会先检索相关证据片段。[ev_aaaaaaaaaaaa]",
      "检索到的证据片段随后用于生成回答。",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.claimCount).toBe(2);
    expect(report.citedClaimCount).toBe(1);
    expect(report.coveredClaimCount).toBe(2);
    expect(report.citationCoverage).toBe(1);
    expect(report.status).toBe("pass");
    expect(report.checks[1]).toMatchObject({ inherited: true, supported: true });
  });

  // 继承不是“旁边有引用就算数”：仍要过最低词面支持线，否则夹带的无关断言
  // 会被同节的一条真引用洗白。
  it("refuses to inherit for a claim the cited evidence does not lexically support", () => {
    const answer = [
      "二、RAG",
      "RAG 会先检索相关证据片段。[ev_aaaaaaaaaaaa]",
      "该产品在所有云厂商的报价中都是最低的。",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.coveredClaimCount).toBe(1);
    expect(report.citationCoverage).toBe(0.5);
    expect(report.checks[1]).toMatchObject({ inherited: false, supported: false });
  });

  // 引用不跨章节继承，否则一节里的一条引用会为整篇回答背书。
  it("does not carry a citation across a section boundary", () => {
    const answer = [
      "二、RAG",
      "RAG 会先检索相关证据片段。[ev_aaaaaaaaaaaa]",
      "三、其他",
      "检索到的证据片段随后用于生成回答。",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.coveredClaimCount).toBe(1);
    expect(report.checks[1]).toMatchObject({ inherited: false });
  });

  it("reports failure when retrieval was required but produced no evidence", () => {
    const report = verifyGroundedAnswer(
      "模型仍然尝试直接回答。",
      [],
      { evidenceRequired: true },
    );

    expect(report.status).toBe("fail");
  });

  it("keeps a direct answer when retrieval was only a soft recommendation", () => {
    const answer = "Kubernetes 使用声明式配置管理集群工作负载。";
    const report = verifyGroundedAnswer(answer, [], { evidenceRequired: false });

    expect(report.status).toBe("pass");
  });
});
