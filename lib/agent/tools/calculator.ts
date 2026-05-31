import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";

type CalculatorInput = {
  expression?: string;
};

function parseInput(input: unknown): CalculatorInput {
  if (!input || typeof input !== "object") {
    return {};
  }
  const value = input as Record<string, unknown>;
  return {
    expression:
      typeof value.expression === "string" ? value.expression : undefined,
  };
}

function isSafeExpression(expression: string): boolean {
  return /^[0-9+\-*/().\s]+$/.test(expression);
}

export const calculatorTool: ToolDefinition = {
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 10,
    memoryLimitMb: 10,
    timeoutSeconds: 3,
  },
  name: "calculator",
  description: "计算数学表达式",
  riskLevel: "safe",
  input_schema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: '要计算的数学表达式，如 "2 + 3 * 4" 或 "sqrt(16)"',
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  execute: async (input) => {
    const { expression } = parseInput(input);
    if (!expression) {
      return {
        ok: false,
        content: "缺少表达式参数",
        error: "Missing expression",
      };
    }
    if (!isSafeExpression(expression)) {
      return {
        ok: false,
        content: "表达式包含不安全字符",
        error: "Unsafe expression",
      };
    }
    try {
      const result = Function(`"use strict"; return (${expression});`)();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return {
          ok: false,
          content: "表达式计算结果不是有效数字",
          error: "Invalid calculation result",
        };
      }

      return {
        ok: true,
        content: `${expression} = ${result}`,
        data: {
          expression,
          result,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: "计算失败",
        error: error instanceof Error ? error.message : "Calculation failed",
      };
    }
  },
};
