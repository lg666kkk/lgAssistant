import { describe, expect, it } from "vitest";
import {
  buildLangfuseEvalCases,
  LANGFUSE_EVAL_DATASET,
} from "./langfuse-dataset";
import { evalCases } from "./cases";
import { retrievalRoutingCases } from "./retrieval-routing-cases";

describe("Langfuse evaluation dataset", () => {
  it("uses stable ids and includes the checked-in agent and routing cases", () => {
    const cases = buildLangfuseEvalCases();

    expect(cases).toHaveLength(evalCases.length + retrievalRoutingCases.length);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(cases.length);
    expect(cases.every((testCase) => testCase.id.length === 32)).toBe(true);
    expect(LANGFUSE_EVAL_DATASET).toBe("personal-assistant-agent-eval-v1");
  });
});
