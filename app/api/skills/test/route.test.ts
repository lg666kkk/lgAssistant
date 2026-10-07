import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST as IMPORT } from "@/app/api/skills/route";
import { POST } from "@/app/api/skills/versions/route";
import { POST as INSTALL } from "@/app/api/skills/install/route";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  importStandardSkill: vi.fn(),
  requireConfigAdmin: vi.fn(),
  listConfiguredSkills: vi.fn(),
  upsertSkillDefinition: vi.fn(),
  deleteSkillDefinition: vi.fn(),
  publishSkillVersion: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireUser: mocks.requireUser,
  requireConfigAdmin: mocks.requireConfigAdmin,
}));

vi.mock("@/lib/sandbox/skills", () => ({
  SANDBOX_PROFILES: [],
  listConfiguredSkills: mocks.listConfiguredSkills,
  upsertSkillDefinition: mocks.upsertSkillDefinition,
  deleteSkillDefinition: mocks.deleteSkillDefinition,
  publishSkillVersion: mocks.publishSkillVersion,
}));

vi.mock("@/lib/sandbox/standard-skill", () => ({ importStandardSkill: mocks.importStandardSkill }));

const skillDraft = {
  id: "markdown-check",
  name: "Markdown Check",
  description: "Check heading levels",
  enabled: false,
};

const versionDraft = {
  skillId: "markdown-check",
  version: "1.0.0",
  runtime: "node",
  entrypoint: ["node", "scripts/run.mjs"],
  profileId: "skill-trusted",
  templateId: "skill-template",
  bundleBase64: "YnVuZGxl",
  inputSchema: "schemas/input.json",
  outputSchema: "schemas/output.json",
};

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/skills", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("user skill routes follow the logged-in user", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.requireConfigAdmin.mockResolvedValue(false);
    mocks.listConfiguredSkills.mockResolvedValue([skillDraft]);
    mocks.upsertSkillDefinition.mockResolvedValue(skillDraft);
    mocks.publishSkillVersion.mockResolvedValue({ skillId: "markdown-check", version: "1.0.0" });
  });

  it("exposes editing to every logged-in user", async () => {
    const skills = [skillDraft, { ...skillDraft, id: "enabled-skill", enabled: true }];
    mocks.listConfiguredSkills.mockResolvedValue(skills);

    const response = await GET(new Request("http://localhost/api/skills"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, canEdit: true, skills });
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it("loads only the logged-in user's catalog", async () => {
    const response = await GET(new Request("http://localhost/api/skills?userId=other-user"));
    expect(await response.json()).toMatchObject({ canEdit: true });
    expect(mocks.listConfiguredSkills).toHaveBeenCalledWith("user-1");
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it("does not update a skill outside the user's catalog", async () => {
    mocks.listConfiguredSkills.mockResolvedValue([]);
    expect((await PATCH(jsonRequest("PATCH", skillDraft))).status).toBe(400);
    expect(mocks.upsertSkillDefinition).not.toHaveBeenCalled();
  });

  it("permits installation requests without administrator permission", async () => {
    // Invalid source stops before any subprocess; authorization still succeeds.
    expect((await INSTALL(jsonRequest("POST", { package: "../bad" }))).status).toBe(400);
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it("preserves browser folder paths across multipart serialization", async () => {
    const form = new FormData();
    form.append("files", new File(["---\nname: test\n---\n"], "SKILL.md"));
    form.append("files", new File(["pass"], "main.py"));
    form.append("paths", JSON.stringify(["SKILL.md", "scripts/main.py"]));
    mocks.importStandardSkill.mockResolvedValue({ id: "test" });
    expect((await IMPORT(new Request("http://localhost/api/skills", { method: "POST", body: form }))).status).toBe(201);
    expect(mocks.importStandardSkill.mock.calls[0][0].files.map((file: File) => file.name)).toEqual(["SKILL.md", "scripts/main.py"]);
  });

  it.each([true, false])("saves skill metadata and enabled=%s using the logged-in actor", async (enabled) => {
    const response = await PATCH(jsonRequest("PATCH", {
      ...skillDraft,
      enabled,
      actorId: "untrusted-actor",
    }));

    expect(response.status).toBe(200);
    expect(mocks.upsertSkillDefinition).toHaveBeenCalledWith({
      ...skillDraft,
      enabled,
      actorId: "user-1",
    });
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it("deletes a skill using the logged-in actor", async () => {
    const response = await DELETE(new Request("http://localhost/api/skills?id=markdown-check", { method: "DELETE" }));

    expect(response.status).toBe(204);
    expect(mocks.deleteSkillDefinition).toHaveBeenCalledWith({ id: "markdown-check", actorId: "user-1" });
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it("publishes a version using the logged-in actor", async () => {
    const response = await POST(jsonRequest("POST", { ...versionDraft, actorId: "untrusted-actor" }));

    expect(response.status).toBe(201);
    expect(mocks.publishSkillVersion).toHaveBeenCalledWith({ ...versionDraft, actorId: "user-1" });
    expect(mocks.requireConfigAdmin).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", handler: GET },
    { method: "PATCH", handler: PATCH },
    { method: "DELETE", handler: DELETE },
    { method: "POST", handler: POST },
    { method: "POST", handler: IMPORT },
    { method: "POST", handler: INSTALL },
  ])("rejects unauthenticated $method requests before accessing skill storage", async ({ method, handler }) => {
    const unauthorized = Response.json({ error: "Unauthorized" }, { status: 401 });
    mocks.requireUser.mockResolvedValue(unauthorized);

    const response = await handler(new Request("http://localhost/api/skills", { method }));

    expect(response).toBe(unauthorized);
    expect(mocks.listConfiguredSkills).not.toHaveBeenCalled();
    expect(mocks.upsertSkillDefinition).not.toHaveBeenCalled();
    expect(mocks.deleteSkillDefinition).not.toHaveBeenCalled();
    expect(mocks.publishSkillVersion).not.toHaveBeenCalled();
  });

  it("still validates metadata before saving", async () => {
    const response = await PATCH(jsonRequest("PATCH", { ...skillDraft, enabled: "yes" }));

    expect(response.status).toBe(400);
    expect(mocks.upsertSkillDefinition).not.toHaveBeenCalled();
  });

  it("still validates publication input", async () => {
    const response = await POST(jsonRequest("POST", { ...versionDraft, runtime: "shell" }));

    expect(response.status).toBe(400);
    expect(mocks.publishSkillVersion).not.toHaveBeenCalled();
  });

  it("preserves active-run deletion conflicts", async () => {
    mocks.deleteSkillDefinition.mockRejectedValue(new Error("Skill 有运行中任务"));

    const response = await DELETE(new Request("http://localhost/api/skills?id=markdown-check", { method: "DELETE" }));

    expect(response.status).toBe(409);
  });
});
