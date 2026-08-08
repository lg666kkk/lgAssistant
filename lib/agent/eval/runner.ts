import {
  runAgentLoop,
  type ToolSourceType,
} from "@/lib/agent/runtime";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";

export type EvalMessage = { role: "user" | "assistant"; content: string };

export type EvalDeps = {
  callModel: any;
};

function createEvalDeps(deps?: EvalDeps): EvalDeps | undefined {
  return deps;
}

export async function runCase(
  messages: EvalMessage[],
  deps?: EvalDeps,
) {
  const registry = createBuiltinToolRegistry();
  const sources: ToolSourceType[] = [];

  return runAgentLoop(
    messages,
    registry.listForModel(),
    registry,
    8,
    sources,
    () => true,
    "eval",
    undefined,
    createEvalDeps(deps),
  );
}

export type EvalRunResult = Awaited<ReturnType<typeof runCase>>;
