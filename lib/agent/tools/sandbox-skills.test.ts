import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/sandbox/skills", () => ({ listConfiguredSkills: mocks.list, getStandardSkill: mocks.read }));
vi.mock("@/lib/sandbox/client", () => ({ createSkillRun: vi.fn(), getSandboxRun: vi.fn() }));
import { listSkillsTool, viewSkillTool } from "./sandbox-skills";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ id: "demo", name: "demo", description: "", enabled: true, skillMd: "instructions", versions: [] }]);
  mocks.read.mockResolvedValue({ id: "demo", skillMd: "instructions", supportFiles: {} });
});
describe("chat Skill tools use the authenticated user's scope", () => {
  it("lists Skills for the runtime user", async () => {
    expect((await listSkillsTool.execute({}, { userId: "user-1" })).ok).toBe(true);
    expect(mocks.list).toHaveBeenCalledWith("user-1");
  });
  it("ignores input identity and reads using the runtime user", async () => {
    expect((await viewSkillTool.execute({ skillId: "demo", userId: "user-2" }, { userId: "user-1" })).ok).toBe(true);
    expect(mocks.read).toHaveBeenCalledWith("user-1", "demo");
  });
  it("never falls back to a global catalog when runtime identity is missing", async () => {
    expect((await listSkillsTool.execute({})).ok).toBe(false);
    expect((await viewSkillTool.execute({ skillId: "demo" })).ok).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
