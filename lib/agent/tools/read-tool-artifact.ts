import { readToolArtifact } from "@/lib/agent/runtime/artifact-store";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

type ReadToolArtifactInput = {
  artifactId: string;
};

function parseInput(input: unknown): ReadToolArtifactInput {
  if (!input || typeof input !== "object") {
    return { artifactId: "" };
  }
  const value = input as Record<string, unknown>;
  return {
    artifactId: typeof value.artifactId === "string" ? value.artifactId : "",
  };
}

export const readToolArtifactTool: ToolDefinition = {
  name: "read_tool_artifact",
  description:
    "读取之前工具调用保存到服务端本地 artifact 存储里的完整结果。当上下文中的工具结果只给出了 artifact_id、摘要或引用，而你需要查看完整原文、完整网页正文、完整搜索结果或完整知识库检索结果时使用。只能读取当前用户当前会话范围内的 artifact。",
  input_schema: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description: "上下文中给出的 artifact_id",
      },
    },
    required: ["artifactId"],
    additionalProperties: false,
  },
  runtime: {
    ...defaultToolRuntimePolicy,
    sideEffect: "read",
    concurrencyGroup: "artifact",
    maxConcurrency: 4,
  },
  riskLevel: "safe",
  execute: async (
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> => {
    const { artifactId } = parseInput(input);
    if (!artifactId.trim()) {
      return {
        ok: false,
        content: "缺少 artifactId",
        error: "Missing artifactId",
      };
    }

    const artifact = await readToolArtifact({
      userId: context?.userId,
      scopeId: context?.scopeId,
      artifactId,
    });

    if (!artifact) {
      return {
        ok: false,
        content: `没有找到 artifact：${artifactId}`,
        error: "Artifact not found",
      };
    }

    return {
      ok: true,
      content: [
        `artifact_id: ${artifact.id}`,
        `tool: ${artifact.toolName}`,
        artifact.toolCallId ? `tool_call_id: ${artifact.toolCallId}` : undefined,
        `created_at: ${artifact.createdAt}`,
        "",
        artifact.content,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
      data: artifact,
      metadata: {
        artifactId: artifact.id,
        toolName: artifact.toolName,
        createdAt: artifact.createdAt,
      },
    };
  },
};

