import { describe, expect, it } from "vitest";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
} from "./types";
import {
  applyGroundednessGuard,
  verifyGroundedAnswer,
} from "./answer-verifier";

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

  it("warns and guards an answer with incomplete claim coverage", () => {
    const answer = [
      "RAG 会先检索相关证据片段。[ev_aaaaaaaaaaaa]",
      "这个方案在所有场景中成本都最低。",
    ].join("\n");
    const report = verifyGroundedAnswer(answer, [bundle()]);

    expect(report.status).toBe("warn");
    expect(report.citationCoverage).toBe(0.5);
    expect(applyGroundednessGuard(answer, report)).toContain("引用覆盖不足");
  });

  it("rejects an answer when retrieval was required but produced no evidence", () => {
    const report = verifyGroundedAnswer(
      "模型仍然尝试直接回答。",
      [],
      { evidenceRequired: true },
    );

    expect(report.status).toBe("fail");
    expect(applyGroundednessGuard("模型仍然尝试直接回答。", report))
      .toBe("当前检索未获得足够证据，无法可靠回答。");
  });

  it("keeps a direct answer when retrieval was only a soft recommendation", () => {
    const answer = "Kubernetes 使用声明式配置管理集群工作负载。";
    const report = verifyGroundedAnswer(answer, [], { evidenceRequired: false });

    expect(report.status).toBe("pass");
    expect(applyGroundednessGuard(answer, report)).toBe(answer);
  });
});
