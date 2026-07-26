import { readToolArtifact } from "@/lib/agent/runtime/artifact-store";
import { sliceTextByTokens } from "@/lib/agent/runtime/tokenizer";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

type ReadToolArtifactInput = {
  artifactId: string;
  offset: number;
  limit: number;
};

const DEFAULT_LIMIT = 1_200;
const MAX_LIMIT = 2_000;

function parseNonNegativeInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseInput(input: unknown): ReadToolArtifactInput {
  if (!input || typeof input !== "object") {
    return { artifactId: "", offset: 0, limit: DEFAULT_LIMIT };
  }
  const value = input as Record<string, unknown>;
  return {
    artifactId: typeof value.artifactId === "string" ? value.artifactId : "",
    offset: parseNonNegativeInteger(value.offset, 0),
    limit: Math.min(
      MAX_LIMIT,
      Math.max(1, parseNonNegativeInteger(value.limit, DEFAULT_LIMIT)),
    ),
  };
}

export const readToolArtifactTool: ToolDefinition = {
  name: "read_tool_artifact",
  capabilities: ["tool_artifact.read"],
  outputPolicy: { grounding: "authoritative_result", citationRequired: false },
  description:
    "按 token 分页读取之前工具调用保存到服务端本地 artifact 存储里的完整结果。当上下文中的工具结果只给出了 artifact_id、摘要或引用，而你需要查看完整原文、完整网页正文、完整搜索结果或完整知识库检索结果时使用。第一次从 offset=0 开始；若结果返回 has_more=true，使用 next_offset 继续读取下一段。不要一次请求过大的 limit。只能读取当前用户当前会话范围内的 artifact。",
  input_schema: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description: "上下文中给出的 artifact_id",
      },
      offset: {
        type: "number",
        description: "要读取的起始 token 偏移量，首次读取为 0",
        default: 0,
      },
      limit: {
        type: "number",
        description: "本次最多读取的 token 数，默认 1200，最大 2000",
        default: DEFAULT_LIMIT,
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
    const { artifactId, offset, limit } = parseInput(input);
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

    const page = sliceTextByTokens(artifact.content, offset, limit);

    return {
      ok: true,
      content: [
        `artifact_id: ${artifact.id}`,
        `tool: ${artifact.toolName}`,
        artifact.toolCallId ? `tool_call_id: ${artifact.toolCallId}` : undefined,
        `created_at: ${artifact.createdAt}`,
        `token_range: ${offset}-${page.endOffset}`,
        `total_tokens: ${page.totalTokens}`,
        `has_more: ${page.hasMore}`,
        page.nextOffset !== null ? `next_offset: ${page.nextOffset}` : undefined,
        "",
        page.content,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
      data: artifact,
      metadata: {
        artifactId: artifact.id,
        toolName: artifact.toolName,
        createdAt: artifact.createdAt,
        offset,
        limit,
        totalTokens: page.totalTokens,
        endOffset: page.endOffset,
        nextOffset: page.nextOffset,
        hasMore: page.hasMore,
      },
    };
  },
};
