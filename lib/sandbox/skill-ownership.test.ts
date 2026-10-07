import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSupabase: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: mocks.getSupabase }));
import { deleteSkillDefinition, getStandardSkill, listConfiguredSkills, publishSkillVersion, SANDBOX_PROFILES, upsertSkillDefinition } from "./skills";

const skill = { id: "demo", name: "demo", description: "", enabled: true, skill_md: "instructions", support_files: {}, created_by: "user-1", deleted_at: null };
function database() {
  return { rpc: mocks.rpc, from: (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      order: () => query,
      maybeSingle: async () => ({ data: filters.every(([key, value]) => skill[key as keyof typeof skill] === value) ? skill : null, error: null }),
      then: (resolve: (value: unknown) => void) => {
        // Version queries must scope through their parent Skill, not version author.
        if (table === "sandbox_skill_versions") {
          expect(filters.some(([key, value]) => key === "sandbox_skills.created_by" && Boolean(value))).toBe(true);
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        const data = filters.every(([key, value]) => skill[key as keyof typeof skill] === value) ? [skill] : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return query;
  } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSupabase.mockReturnValue(database());
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
describe("Skill ownership checks", () => {
  it("only lists the owner's installations and scopes versions through their parent", async () => {
    expect(await listConfiguredSkills("user-1")).toMatchObject([{ id: "demo" }]);
    expect(await listConfiguredSkills("user-2")).toEqual([]);
  });
  it("rejects another user's instructions and missing user context", async () => {
    await expect(getStandardSkill("user-2", "demo")).rejects.toThrow("不存在");
    await expect(listConfiguredSkills("")).rejects.toThrow("用户身份");
    await expect(getStandardSkill("", "demo")).rejects.toThrow("用户身份");
  });
  it("allows the creator to read and delete their Skill", async () => {
    expect(await getStandardSkill("user-1", "demo")).toMatchObject({ id: "demo", skillMd: "instructions" });
    await deleteSkillDefinition({ id: "demo", actorId: "user-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("delete_sandbox_skill", { p_id: "demo", p_actor_id: "user-1" });
  });
  it("blocks foreign edits, deletions and publications before invoking mutating RPCs", async () => {
    await expect(upsertSkillDefinition({ id: "demo", name: "changed", enabled: false, actorId: "user-2" })).rejects.toThrow("无权访问");
    await expect(deleteSkillDefinition({ id: "demo", actorId: "user-2" })).rejects.toThrow("无权访问");
    await expect(publishSkillVersion({
      skillId: "demo", version: "1.0.0", runtime: "node", entrypoint: ["node", "main.mjs"],
      profileId: "skill-trusted", templateId: SANDBOX_PROFILES[0].templateId,
      bundleBase64: Buffer.from("bundle").toString("base64"), inputSchema: "input.json", outputSchema: "output.json", actorId: "user-2",
    })).rejects.toThrow("无权访问");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
