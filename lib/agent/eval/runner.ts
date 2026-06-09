import {
  callModel,
  runAgentLoop,
  type ToolSourceType,
} from "@/lib/agent/runtime";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";

export type EvalMessage = { role: "user" | "assistant"; content: string };

export type EvalDeps = {
  callModel: any;
};

const SHOULD_LOG_MODEL = process.env.EVAL_LOG_MODEL === "1";

function createEvalDeps(deps?: EvalDeps): EvalDeps | undefined {
  if (deps) return deps;
  if (!SHOULD_LOG_MODEL) return undefined;

  return {
    callModel: async (...args: Parameters<typeof callModel>) => {
      const response = await callModel(...args);
      console.log("[EvalModelResponse]", {
        id: response.id,
        model: response.model,
        stopReason: response.stop_reason,
        usage: response.usage,
        content: response.content.map((block) => {
          if (block.type === "text") {
            return {
              type: block.type,
              textPreview: block.text.slice(0, 120),
            };
          }

          if (block.type === "tool_use") {
            return {
              type: block.type,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }

          return { type: block.type };
        }),
      });

      return response;
    },
  };
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
