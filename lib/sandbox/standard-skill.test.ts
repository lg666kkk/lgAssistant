import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: () => ({ from: () => ({ upsert: mocks.upsert }) }) }));
import { importStandardSkill } from "./standard-skill";
const markdown = "---\nname: demo\ndescription: demo skill\n---\nRun scripts/main.py";
const file = (name: string, text: string, root?: string) => Object.assign(new File([text], name), root ? { webkitRelativePath: root } : {});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockReturnValue({ select: () => ({ single: async () => ({ data: {}, error: null }) }) });
});
describe("standard skill paths", () => {
  it("retains nested CLI paths and distinct files with the same basename", async () => {
    await importStandardSkill({ actorId: "admin", files: [file("SKILL.md", markdown), file("scripts/main.py", "pass"), file("scripts/util.py", "script"), file("references/util.py", "reference")] });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ support_files: {
      "scripts/main.py": "pass", "scripts/util.py": "script", "references/util.py": "reference",
    } }), { onConflict: "id" });
  });
  it("removes only the browser-selected root directory", async () => {
    await importStandardSkill({ actorId: "admin", files: [file("SKILL.md", markdown, "demo/SKILL.md"), file("main.py", "pass", "demo/scripts/main.py")] });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ support_files: { "scripts/main.py": "pass" } }), { onConflict: "id" });
  });
  it.each(["../escape", "/tmp/escape", "scripts\\escape"])("rejects unsafe path %s", async (name) => {
    await expect(importStandardSkill({ actorId: "admin", files: [file("SKILL.md", markdown), file(name, "bad")] })).rejects.toThrow("不安全路径");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects duplicate relative paths rather than replacing their content", async () => {
    await expect(importStandardSkill({ actorId: "admin", files: [file("SKILL.md", markdown), file("main.py", "one"), file("main.py", "two")] })).rejects.toThrow("重复路径");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
