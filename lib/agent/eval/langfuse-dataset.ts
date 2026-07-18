import { createHash } from "node:crypto";
import { evalCases, type EvalCase } from "./cases";
import { retrievalRoutingCases } from "./retrieval-routing-cases";
import type { RetrievalRoutingCase } from "./retrieval-routing";

export const LANGFUSE_EVAL_DATASET = "personal-assistant-agent-eval-v1";

export type LangfuseAgentEvalInput = {
  kind: "agent";
  caseId: string;
  messages: EvalCase["messages"];
};

export type LangfuseRoutingEvalInput = {
  kind: "routing";
  caseId: string;
  query: string;
  knowledgeProfile?: string;
  webEnabled?: boolean;
};

export type LangfuseEvalInput = LangfuseAgentEvalInput | LangfuseRoutingEvalInput;

export type LangfuseEvalCase = {
  id: string;
  input: LangfuseEvalInput;
  expectedOutput: EvalCase["expect"] | Pick<RetrievalRoutingCase, "expectedRoute">;
  metadata: Record<string, unknown>;
};

function stableId(caseId: string) {
  return createHash("sha256")
    .update(`${LANGFUSE_EVAL_DATASET}:${caseId}`)
    .digest("hex")
    .slice(0, 32);
}

export function buildLangfuseEvalCases(): LangfuseEvalCase[] {
  const agentCases = evalCases.map((testCase) => ({
    id: stableId(`agent:${testCase.id}`),
    input: {
      kind: "agent" as const,
      caseId: testCase.id,
      messages: testCase.messages,
    },
    expectedOutput: testCase.expect,
    metadata: {
      source: "lib/agent/eval/cases.ts",
      kind: "agent",
      caseId: testCase.id,
      description: testCase.description,
    },
  }));
  const routingCases = retrievalRoutingCases.map((testCase) => ({
    id: stableId(`routing:${testCase.id}`),
    input: {
      kind: "routing" as const,
      caseId: testCase.id,
      query: testCase.query,
      knowledgeProfile: testCase.knowledgeProfile,
      webEnabled: testCase.webEnabled,
    },
    expectedOutput: { expectedRoute: testCase.expectedRoute },
    metadata: {
      source: "lib/agent/eval/retrieval-routing-cases.ts",
      kind: "routing",
      caseId: testCase.id,
    },
  }));

  return [...agentCases, ...routingCases];
}

export function isLangfuseEvalInput(value: unknown): value is LangfuseEvalInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    (input.kind === "agent" && Array.isArray(input.messages))
    || (input.kind === "routing" && typeof input.query === "string")
  );
}
