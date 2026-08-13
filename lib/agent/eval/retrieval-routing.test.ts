import { describe, expect, it } from "vitest";
import { buildRetrievalPlan } from "@/lib/agent/rag/retrieval-router";
import { retrievalRoutingCases } from "./datasets/retrieval-routing";
import { summarizeRetrievalRouting } from "./retrieval-routing";

describe("retrieval routing eval", () => {
  it("meets the checked-in route precision and recall gate", () => {
    const predictions = retrievalRoutingCases.map((testCase) => {
      const plan = buildRetrievalPlan({
        query: testCase.query,
        knowledgeProfile: testCase.knowledgeProfile,
        webEnabled: testCase.webEnabled,
      });
      return {
        ...testCase,
        predictedRoute: plan.route,
        reason: plan.reason,
      };
    });
    const summary = summarizeRetrievalRouting(predictions);

    expect(summary.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(summary.retrieval.precision).toBeGreaterThanOrEqual(0.9);
    expect(summary.retrieval.recall).toBeGreaterThanOrEqual(0.9);
    expect(summary.knowledge.precision).toBeGreaterThanOrEqual(0.9);
    expect(summary.web.precision).toBeGreaterThanOrEqual(0.9);
  });
});
