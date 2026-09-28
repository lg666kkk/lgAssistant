import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  kill: vi.fn(),
  readSkillBundle: vi.fn(),
  validateSkillJSON: vi.fn(),
  getSupabase: vi.fn(),
  getE2BApiKey: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: { create: mocks.create, kill: mocks.kill },
  CommandExitError: class CommandExitError extends Error {},
}));
vi.mock("./bundle", () => ({
  readSkillBundle: mocks.readSkillBundle,
  validateSkillJSON: mocks.validateSkillJSON,
}));
vi.mock("./skills", () => ({
  SANDBOX_PROFILES: [{ id: "skill-trusted", templateId: "base", timeoutSeconds: 30 }],
}));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: mocks.getSupabase }));
vi.mock("./config", () => ({ getE2BApiKey: mocks.getE2BApiKey }));

import { cancelSandboxRun, createSkillRun, getSandboxRun } from "./client";

function fakeDatabase() {
  const version = {
    skill_id: "markdown-check", version: "1.0.0", entrypoint: ["node", "scripts/run.mjs"],
    profile_id: "skill-trusted", e2b_template_id: "base", bundle_sha256: "a".repeat(64),
    bundle: "\\x00", input_schema_path: "schemas/input.json", output_schema_path: "schemas/output.json",
    sandbox_skills: { enabled: true, deleted_at: null },
  };
  let run: Record<string, any> | null = null;
  const from = (table: string) => {
    let action = "select";
    let patch: Record<string, any> = {};
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (name: string, value: unknown) => { filters.push([name, value]); return query; },
      is: () => query,
      in: () => query,
      insert: (value: Record<string, any>) => { action = "insert"; patch = value; return query; },
      update: (value: Record<string, any>) => { action = "update"; patch = value; return query; },
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise.resolve(result()).then(resolve, reject),
    };
    function result() {
      if (table === "sandbox_skill_versions") return { data: version, error: null };
      if (action === "insert") {
        run = { ...patch, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        return { data: { ...run }, error: null };
      }
      if (!run || filters.some(([name, value]) => run?.[name] !== value)) return { data: null, error: null };
      if (action === "update") Object.assign(run, patch);
      return { data: { ...run }, error: null };
    }
    return query;
  };
  return { from, currentRun: () => run };
}

describe("E2B Skill runs", () => {
  beforeEach(() => {
    process.env.E2B_API_KEY = "test-key";
    mocks.create.mockReset();
    mocks.kill.mockReset().mockResolvedValue(true);
    mocks.readSkillBundle.mockReset().mockResolvedValue(new Map([
      ["schemas/input.json", Buffer.from("{}")],
      ["schemas/output.json", Buffer.from("{}")],
      ["scripts/run.mjs", Buffer.from("console.log('ok')")],
    ]));
    mocks.validateSkillJSON.mockReset();
    mocks.getSupabase.mockReset();
    mocks.getE2BApiKey.mockReset().mockResolvedValue("saved-key");
  });

  afterEach(() => { delete process.env.E2B_API_KEY; });

  it("runs a published version with internet disabled and stores its result", async () => {
    const database = fakeDatabase();
    mocks.getSupabase.mockReturnValue(database);
    const files = { write: vi.fn().mockResolvedValue({}), read: vi.fn().mockResolvedValue('{"valid":true}') };
    const commands = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }) };
    mocks.create.mockResolvedValue({ sandboxId: "sandbox-1", files, commands });

    const created = await createSkillRun({
      userId: "user-1", runId: "skill-run-1", idempotencyKey: "once", skillId: "markdown-check",
      skillVersion: "1.0.0", skillInput: { markdown: "# Title" },
    });
    expect(created.status).toBe("queued");
    await vi.waitFor(() => expect(database.currentRun()?.status).toBe("completed"));
    expect(mocks.create).toHaveBeenCalledWith("base", expect.objectContaining({ apiKey: "saved-key", allowInternetAccess: false }));
    expect(mocks.getE2BApiKey).toHaveBeenCalledWith("user-1");
    expect(commands.run).toHaveBeenCalledWith("'node' 'scripts/run.mjs'", expect.objectContaining({ cwd: "/home/user/workspace" }));
    expect(await getSandboxRun("user-1", created.runId)).toMatchObject({ status: "completed", result: { valid: true } });
    expect(mocks.kill).toHaveBeenCalledWith("sandbox-1", { apiKey: "saved-key" });
  });

  it("kills the remote sandbox and prevents a cancelled run from completing", async () => {
    const database = fakeDatabase();
    mocks.getSupabase.mockReturnValue(database);
    let finishCommand!: (value: unknown) => void;
    const pendingCommand = new Promise((resolve) => { finishCommand = resolve; });
    mocks.create.mockResolvedValue({
      sandboxId: "sandbox-2",
      files: { write: vi.fn().mockResolvedValue({}), read: vi.fn().mockResolvedValue("{}") },
      commands: { run: vi.fn().mockReturnValue(pendingCommand) },
    });
    await createSkillRun({
      userId: "user-1", runId: "skill-run-2", idempotencyKey: "twice", skillId: "markdown-check",
      skillVersion: "1.0.0", skillInput: {},
    });
    await vi.waitFor(() => expect(database.currentRun()?.status).toBe("running"));
    await cancelSandboxRun("user-1", "skill-run-2");
    finishCommand({ exitCode: 0, stdout: "ok", stderr: "" });
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledWith("sandbox-2", { apiKey: "saved-key" }));
    expect(database.currentRun()?.status).toBe("cancelled");
  });
});
