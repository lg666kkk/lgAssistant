import { createHash, randomUUID } from "node:crypto";
import { createSkillRun, getSandboxRun } from "@/lib/sandbox/client";
import { getStandardSkill, listConfiguredSkills } from "@/lib/sandbox/skills";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

export const listSkillsTool: ToolDefinition = {
  name: "list_skills",
  capabilities: ["sandbox.skill.list"],
  outputPolicy: { grounding: "authoritative_result", citationRequired: false },
  description: "发现当前已启用的标准 SKILL.md 和可执行沙盒 Skill。需要使用标准 Skill 时，再调用 view_skill 加载完整说明。",
  runtime: {
    ...defaultToolRuntimePolicy,
    requiresAuth: true,
    sandboxed: false,
    sideEffect: "read",
    timeoutSeconds: 10,
  },
  riskLevel: "safe",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  execute: async (): Promise<ToolResult> => {
    try {
      const skills = (await listConfiguredSkills())
        .filter((skill) => skill.enabled && (skill.skillMd || skill.versions.length > 0))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          kind: skill.skillMd ? "standard" : "sandbox",
          hasInstructions: Boolean(skill.skillMd),
          versions: skill.versions.map((version) => ({
            version: version.version,
            runtime: version.runtime,
            profileId: version.profileId,
            inputSchema: version.inputSchema,
            outputSchema: version.outputSchema,
          })),
        }));
      return {
        ok: true,
        content: skills.length > 0
          ? JSON.stringify(skills, null, 2)
          : "当前没有已启用且已发布的 Skill。",
        data: { skills },
      };
    } catch (error) {
      return {
        ok: false,
        content: "读取 Skill 配置失败。",
        error: error instanceof Error ? error.message : "List skills failed",
      };
    }
  },
};

export const viewSkillTool: ToolDefinition = {
  name: "view_skill",
  capabilities: ["sandbox.skill.view"],
  outputPolicy: { grounding: "authoritative_result", citationRequired: false },
  description: "加载一个已启用标准 Skill 的 SKILL.md 说明和附属文本文件。先调用 list_skills 获取 skillId。",
  runtime: {
    ...defaultToolRuntimePolicy,
    requiresAuth: true,
    sandboxed: false,
    sideEffect: "read",
    timeoutSeconds: 10,
  },
  riskLevel: "safe",
  input_schema: {
    type: "object",
    properties: { skillId: { type: "string", description: "list_skills 返回的 Skill ID" } },
    required: ["skillId"],
    additionalProperties: false,
  },
  execute: async (value: unknown): Promise<ToolResult> => {
    if (!value || typeof value !== "object" || typeof (value as { skillId?: unknown }).skillId !== "string") {
      return { ok: false, content: "skillId 为必填项。", error: "Invalid skillId" };
    }
    try {
      const skill = await getStandardSkill((value as { skillId: string }).skillId);
      const files = Object.keys(skill.supportFiles);
      return {
        ok: true,
        content: JSON.stringify({ ...skill, supportFiles: skill.supportFiles }, null, 2),
        data: { skillId: skill.id, files },
      };
    } catch (error) {
      return { ok: false, content: "读取 Skill 内容失败。", error: error instanceof Error ? error.message : "View skill failed" };
    }
  },
};

export const runSkillTool: ToolDefinition = {
  name: "run_skill",
  capabilities: ["sandbox.skill.run"],
  outputPolicy: { grounding: "action_receipt", citationRequired: false },
  description: "按已发布的不可变版本在隔离沙盒中运行 Skill。只能提交 skillId、skillVersion 和符合该版本输入 Schema 的 input；实际命令、镜像、网络和资源限制由 Skill 配置决定。",
  runtime: {
    ...defaultToolRuntimePolicy,
    requiresAuth: true,
    sandboxed: true,
    sideEffect: "none",
    timeoutSeconds: 30,
    memoryLimitMb: 256,
    concurrencyGroup: "sandbox-skill",
    maxConcurrency: 2,
  },
  riskLevel: "safe",
  input_schema: {
    type: "object",
    properties: {
      skillId: { type: "string", description: "list_skills 返回的 Skill ID" },
      skillVersion: { type: "string", description: "已发布的语义化版本" },
      input: { type: "object", description: "符合该版本输入 Schema 的 JSON 对象", additionalProperties: true },
    },
    required: ["skillId", "skillVersion", "input"],
    additionalProperties: false,
  },
  execute: async (value: unknown, context?: ToolExecutionContext): Promise<ToolResult> => {
    if (!context?.userId) {
      return { ok: false, content: "运行 Skill 需要先登录。", error: "Missing userId" };
    }
    if (!value || typeof value !== "object") {
      return { ok: false, content: "Skill 参数格式错误。", error: "Input must be an object" };
    }
    const input = value as Record<string, unknown>;
    if (typeof input.skillId !== "string" || typeof input.skillVersion !== "string" || !isJSONInput(input.input)) {
      return { ok: false, content: "skillId、skillVersion 和 input 为必填项。", error: "Invalid skill input" };
    }
    const runId = `skill-${randomUUID()}`;
    const idempotencyKey = createHash("sha256").update(JSON.stringify({
      userId: context.userId,
      requestId: context.requestId ?? runId,
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      input: input.input,
    })).digest("hex");
    try {
      let run = await createSkillRun({
        userId: context.userId,
        runId,
        idempotencyKey,
        skillId: input.skillId,
        skillVersion: input.skillVersion,
        skillInput: input.input,
      });
      const deadline = Date.now() + 20_000;
      while (!isTerminal(run.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        run = await getSandboxRun(context.userId, run.runId);
      }
      const resultText = run.result === undefined ? "" : JSON.stringify(run.result);
      const resultPreview = resultText.length > 8_000
        ? `${resultText.slice(0, 8_000)}\n[结果已截断，完整内容见 resultRef]`
        : resultText;
      return {
        ok: run.status === "completed" || !isTerminal(run.status),
        content: [
          `Skill Run：${run.runId}`,
          `状态：${run.status}`,
          run.stdoutRef ? `stdout：${run.stdoutRef}` : "",
          run.stderrRef ? `stderr：${run.stderrRef}` : "",
          run.resultRef ? `result：${run.resultRef}` : "",
          resultPreview ? `输出：${resultPreview}` : "",
          run.message ?? "",
        ].filter(Boolean).join("\n"),
        data: {
          ...run,
          result: resultText.length <= 8_000 ? run.result : undefined,
          resultTruncated: resultText.length > 8_000,
        },
        error: isTerminal(run.status) && run.status !== "completed" ? run.message ?? run.status : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        content: "Skill Run 创建或查询失败。",
        error: error instanceof Error ? error.message : "Run skill failed",
      };
    }
  },
};

function isJSONInput(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(status: string) {
  return ["completed", "failed", "timed_out", "cancelled", "dead", "unavailable"].includes(status);
}
