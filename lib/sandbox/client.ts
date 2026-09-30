import { createHash } from "node:crypto";
import { CommandExitError, Sandbox } from "e2b";
import { getSupabase } from "@/lib/platform/supabase";
import { readSkillBundle, validateSkillJSON } from "./bundle";
import { getE2BApiKey } from "./config";
import { SANDBOX_PROFILES } from "./skills";

const WORKSPACE = "/home/user/workspace";
const MAX_LOG_LENGTH = 64_000;
const TERMINAL = ["completed", "failed", "timed_out", "cancelled", "dead", "unavailable"];
const MAX_EXECUTION_LOG_EVENTS = 64;
const LEGACY_DESCRIPTION_RUNNER = "import { readFile } from 'node:fs/promises'; const skillMd = await readFile('SKILL.md', 'utf8'); console.log(JSON.stringify({ kind: 'description', skillMd, files: ['SKILL.md'] }));";

export type SandboxExecutionLogEvent = {
  phase: string;
  at: string;
  elapsedMs: number;
  details?: Record<string, unknown>;
};

export type SandboxRun = {
  runId: string;
  kind: "command" | "skill" | "coding";
  status: string;
  skillId: string;
  skillVersion: string;
  profileId: string;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  message?: string;
  executionLog?: SandboxExecutionLogEvent[];
  createdAt: string;
  updatedAt: string;
};

type VersionRow = {
  skill_id: string;
  version: string;
  entrypoint: string[];
  profile_id: string;
  e2b_template_id: string | null;
  bundle_sha256: string;
  bundle: string;
  input_schema_path: string;
  output_schema_path: string;
};

export async function createSkillRun(input: {
  userId: string;
  sessionId?: string;
  toolCallId?: string;
  runId: string;
  idempotencyKey: string;
  skillId: string;
  skillVersion: string;
  skillInput: unknown;
}): Promise<SandboxRun> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 256) throw new Error("幂等键格式错误");
  const version = await loadVersion(input.skillId, input.skillVersion);
  if (!version.e2b_template_id) throw new Error("旧版 Skill 使用本地镜像，请发布新的 E2B 版本");
  const profile = SANDBOX_PROFILES.find((item) => item.id === version.profile_id);
  if (!profile || profile.templateId !== version.e2b_template_id) {
    throw new Error("Skill 的 E2B 模板与当前 Profile 不匹配");
  }
  const files = await readSkillBundle(decodeBundle(version.bundle), version.bundle_sha256);
  if (version.entrypoint[1] === "scripts/run.mjs"
    && files.get("scripts/run.mjs")?.toString("utf8") === LEGACY_DESCRIPTION_RUNNER) {
    throw new Error("这是仅供阅读的 SKILL.md，自动生成的旧版本不会执行其中的命令；请使用 view_skill，或另行发布真正可执行的 Bundle");
  }
  const schema = files.get(version.input_schema_path);
  if (!schema) throw new Error("Skill 输入 Schema 不存在");
  validateSkillJSON(schema, input.skillInput);
  await getE2BApiKey(input.userId);

  const database = getSupabase();
  const inputHash = createHash("sha256").update(JSON.stringify(input.skillInput)).digest("hex");
  const { data, error } = await database.from("sandbox_runs").insert({
    id: input.runId,
    user_id: input.userId,
    session_id: input.sessionId ?? null,
    tool_call_id: input.toolCallId ?? null,
    request_id: input.runId,
    kind: "skill",
    profile_id: version.profile_id,
    skill_id: version.skill_id,
    skill_version: version.version,
    skill_bundle_sha256: version.bundle_sha256,
    idempotency_key: input.idempotencyKey,
    input_hash: inputHash,
    command: version.entrypoint,
    input: input.skillInput,
    timeout_seconds: profile.timeoutSeconds,
    max_attempts: 1,
    status: "queued",
    execution_log: [{ phase: "queued", at: new Date().toISOString(), elapsedMs: 0 }],
  }).select("*").single();
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await database.from("sandbox_runs").select("*")
        .eq("user_id", input.userId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
      if (existing?.input_hash === inputHash && existing.skill_id === input.skillId && existing.skill_version === input.skillVersion) {
        return toRun(existing);
      }
    }
    throw new Error(`创建 Skill Run 失败：${error.message}`);
  }
  void executeSkillRun(data.id).catch(async (runError) => {
    await failRun(data.id, runError).catch(() => undefined);
  });
  return toRun(data);
}

export async function getSandboxRun(userId: string, runId: string): Promise<SandboxRun> {
  const database = getSupabase();
  const { data, error } = await database.from("sandbox_runs").select("*")
    .eq("user_id", userId).eq("id", runId).single();
  if (error || !data) throw new Error("Skill Run 不存在");
  if (!TERMINAL.includes(data.status) && Date.now() - Date.parse(data.created_at) > (data.timeout_seconds + 90) * 1000) {
    if (data.e2b_sandbox_id) {
      const apiKey = await getE2BApiKey(userId);
      await Sandbox.kill(data.e2b_sandbox_id, { apiKey }).catch(() => undefined);
    }
    await failRun(runId, new Error("运行服务中断或超时"));
    return getSandboxRun(userId, runId);
  }
  return toRun(data);
}

export async function cancelSandboxRun(userId: string, runId: string): Promise<void> {
  const database = getSupabase();
  const { data, error } = await database.from("sandbox_runs").select("id,status,e2b_sandbox_id")
    .eq("user_id", userId).eq("id", runId).single();
  if (error || !data) throw new Error("Skill Run 不存在");
  if (TERMINAL.includes(data.status)) return;
  const { data: requested, error: requestError } = await database.from("sandbox_runs").update({
    cancel_requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", runId).in("status", ["queued", "preparing", "running", "collecting_artifacts"])
    .select("e2b_sandbox_id").maybeSingle();
  if (requestError) throw new Error(`取消 Skill Run 失败：${requestError.message}`);
  if (!requested) return;
  if (requested.e2b_sandbox_id) {
    const apiKey = await getE2BApiKey(userId);
    await Sandbox.kill(requested.e2b_sandbox_id, { apiKey });
  }
  const { error: updateError } = await database.from("sandbox_runs").update({
    status: "cancelled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", runId).in("status", ["queued", "preparing", "running", "collecting_artifacts"]);
  if (updateError) throw new Error(`取消 Skill Run 失败：${updateError.message}`);
}

async function executeSkillRun(runId: string): Promise<void> {
  const database = getSupabase();
  const { data: run, error } = await database.from("sandbox_runs").update({
    status: "preparing", updated_at: new Date().toISOString(),
  }).eq("id", runId).eq("status", "queued").is("cancel_requested_at", null).select("*").maybeSingle();
  if (error || !run) return;
  const startedAt = Date.now();
  await appendExecutionLog(runId, startedAt, "preparing");
  let sandbox: Sandbox | undefined;
  let apiKey: string | undefined;
  try {
    apiKey = await getE2BApiKey(run.user_id);
    await appendExecutionLog(runId, startedAt, "credentials_resolved");
    const version = await loadVersion(run.skill_id, run.skill_version);
    if (!version.e2b_template_id || version.bundle_sha256 !== run.skill_bundle_sha256) {
      throw new Error("Skill 发布版本与 Run 绑定不匹配");
    }
    const files = await readSkillBundle(decodeBundle(version.bundle), version.bundle_sha256);
    const inputSchema = files.get(version.input_schema_path);
    const outputSchema = files.get(version.output_schema_path);
    if (!inputSchema || !outputSchema) throw new Error("Skill 的输入或输出 Schema 不存在");
    validateSkillJSON(inputSchema, run.input);
    sandbox = await Sandbox.create(version.e2b_template_id, {
      apiKey,
      allowInternetAccess: false,
      timeoutMs: (run.timeout_seconds + 60) * 1000,
      metadata: { runId },
    });
    await appendExecutionLog(runId, startedAt, "sandbox_created", { sandboxId: sandbox.sandboxId });
    const { data: active } = await database.from("sandbox_runs").update({
      e2b_sandbox_id: sandbox.sandboxId, status: "running", started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", runId).eq("status", "preparing").is("cancel_requested_at", null).select("id").maybeSingle();
    if (!active) return;
    for (const [path, contents] of Array.from(files.entries())) {
      await sandbox.files.write(`${WORKSPACE}/${path}`, Uint8Array.from(contents).buffer);
    }
    await sandbox.files.write(`${WORKSPACE}/input.json`, JSON.stringify(run.input));
    await appendExecutionLog(runId, startedAt, "files_uploaded", { fileCount: files.size + 1 });
    const command = version.entrypoint.map(shellQuote).join(" ");
    const commandResult = await sandbox.commands.run(command, {
      cwd: WORKSPACE,
      timeoutMs: run.timeout_seconds * 1000,
    });
    await appendExecutionLog(runId, startedAt, "command_completed", {
      exitCode: commandResult.exitCode,
      stdoutChars: commandResult.stdout.length,
      stderrChars: commandResult.stderr.length,
    });
    const { data: collecting } = await database.from("sandbox_runs").update({
      status: "collecting_artifacts", stdout: commandResult.stdout.slice(0, MAX_LOG_LENGTH),
      stderr: commandResult.stderr.slice(0, MAX_LOG_LENGTH), exit_code: commandResult.exitCode,
      updated_at: new Date().toISOString(),
    }).eq("id", runId).eq("status", "running").is("cancel_requested_at", null).select("id").maybeSingle();
    if (!collecting) return;
    const outputText = await sandbox.files.read(`${WORKSPACE}/result.json`);
    await appendExecutionLog(runId, startedAt, "result_read", { resultChars: outputText.length });
    if (Buffer.byteLength(outputText) > 1024 * 1024) throw new Error("Skill 结果超过 1MiB");
    const result = JSON.parse(outputText);
    validateSkillJSON(outputSchema, result);
    await database.from("sandbox_runs").update({
      status: "completed", result, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", runId).eq("status", "collecting_artifacts").is("cancel_requested_at", null);
    await appendExecutionLog(runId, startedAt, "completed");
  } catch (runError) {
    await appendExecutionLog(runId, startedAt, "failed", {
      message: runError instanceof Error ? runError.message.slice(0, 500) : "unknown",
    });
    await failRun(runId, runError);
  } finally {
    if (sandbox) {
      await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch(() => undefined);
      await appendExecutionLog(runId, startedAt, "sandbox_destroyed", { sandboxId: sandbox.sandboxId });
    }
  }
}

async function appendExecutionLog(
  runId: string,
  startedAt: number,
  phase: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const database = getSupabase();
  const { data } = await database.from("sandbox_runs").select("execution_log").eq("id", runId).maybeSingle();
  const previous = Array.isArray(data?.execution_log) ? data.execution_log as SandboxExecutionLogEvent[] : [];
  const next = [...previous, { phase, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, details }]
    .slice(-MAX_EXECUTION_LOG_EVENTS);
  await database.from("sandbox_runs").update({ execution_log: next, updated_at: new Date().toISOString() }).eq("id", runId);
}

async function failRun(runId: string, error: unknown): Promise<void> {
  const commandError = error instanceof CommandExitError ? error : null;
  const timedOut = error instanceof Error && /timeout|timed out/i.test(error.message);
  const database = getSupabase();
  const { data: run } = await database.from("sandbox_runs").select("status,cancel_requested_at")
    .eq("id", runId).maybeSingle();
  if (!run || TERMINAL.includes(run.status)) return;
  const { error: updateError } = await database.from("sandbox_runs").update({
    status: run.cancel_requested_at ? "cancelled" : run.status === "queued" ? "dead" : timedOut && run.status === "running" ? "timed_out" : "failed",
    error_message: error instanceof Error ? error.message.slice(0, 1000) : "Skill 执行失败",
    stdout: commandError?.stdout.slice(0, MAX_LOG_LENGTH),
    stderr: commandError?.stderr.slice(0, MAX_LOG_LENGTH),
    exit_code: commandError?.exitCode,
    timed_out: timedOut,
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", runId).in("status", ["queued", "preparing", "running", "collecting_artifacts"]);
  if (updateError) throw new Error(`记录 Skill Run 失败：${updateError.message}`);
}

async function loadVersion(skillId: string, version: string): Promise<VersionRow> {
  const database = getSupabase();
  const { data, error } = await database.from("sandbox_skill_versions")
    .select("skill_id,version,entrypoint,profile_id,e2b_template_id,bundle_sha256,bundle,input_schema_path,output_schema_path,sandbox_skills!inner(enabled,deleted_at)")
    .eq("skill_id", skillId).eq("version", version).single();
  if (error || !data || !data.sandbox_skills?.enabled || data.sandbox_skills.deleted_at) {
    throw new Error("Skill 版本不存在或未启用");
  }
  return data as VersionRow;
}

function decodeBundle(value: string): Buffer {
  if (typeof value !== "string" || !/^\\x[0-9a-f]+$/i.test(value)) {
    throw new Error("数据库返回的 Skill Bundle 格式错误");
  }
  return Buffer.from(value.slice(2), "hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toRun(row: Record<string, any>): SandboxRun {
  return {
    runId: row.id,
    kind: row.kind,
    status: row.status,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    profileId: row.profile_id,
    result: row.result ?? undefined,
    stdout: row.stdout ?? undefined,
    stderr: row.stderr ?? undefined,
    message: row.error_message ?? undefined,
    executionLog: Array.isArray(row.execution_log) ? row.execution_log : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
