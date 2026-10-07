import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: mocks.getSupabase }));
import { importStandardSkill } from "./standard-skill";
const markdown = "---\nname: demo\ndescription: demo skill\n---\nRun scripts/main.py";
const file = (name: string, text: string, root?: string) => Object.assign(new File([text], name), root ? { webkitRelativePath: root } : {});
type Row = Record<string, unknown>;
let rows: Row[];
function database() {
  return { from: () => {
    let action = "select";
    let patch: Row = {};
    const filters: Array<(row: Row) => boolean> = [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
      insert: (value: Row) => { action = "insert"; patch = value; return query; },
      update: (value: Row) => { action = "update"; patch = value; return query; },
      maybeSingle: async () => ({ data: rows.find(row => filters.every(filter => filter(row))) ?? null, error: null }),
      single: async () => {
        if (action === "insert") {
          if (rows.some(row => row.id === patch.id)) return { data: null, error: { message: "duplicate key" } };
          rows.push({ ...patch });
          return { data: rows.at(-1), error: null };
        }
        const row = rows.find(row => filters.every(filter => filter(row)));
        if (row && action === "update") Object.assign(row, patch);
        return { data: row ?? null, error: row ? null : { message: "not found" } };
      },
    };
    return query;
  } };
}
beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mocks.getSupabase.mockReturnValue(database());
});
describe("standard skill user ownership and paths", () => {
  it("retains nested CLI paths and distinct files with the same basename", async () => {
    await importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown), file("scripts/main.py", "pass"), file("scripts/util.py", "script"), file("references/util.py", "reference")] });
    expect(rows[0]).toMatchObject({ created_by: "user-1", support_files: {
      "scripts/main.py": "pass", "scripts/util.py": "script", "references/util.py": "reference",
    } });
  });
  it("removes only the browser-selected root directory", async () => {
    await importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown, "demo/SKILL.md"), file("main.py", "pass", "demo/scripts/main.py")] });
    expect(rows[0]).toMatchObject({ support_files: { "scripts/main.py": "pass" } });
  });
  it("allows independent same-name installations and only updates the importing user's copy", async () => {
    const first = await importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown)] });
    const second = await importStandardSkill({ actorId: "user-2", files: [file("SKILL.md", markdown)] });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    await importStandardSkill({ actorId: "user-2", files: [file("SKILL.md", `${markdown}\nUpdated`)] });
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.created_by === "user-1")?.skill_md).toBe(markdown);
    expect(rows.find(row => row.created_by === "user-2")?.skill_md).toContain("Updated");
  });
  it("preserves a legacy installation for its creator without overwriting it for another user", async () => {
    rows.push({ id: "demo", created_by: "user-1", skill_md: "legacy" });
    expect((await importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown)] })).id).toBe("demo");
    expect((await importStandardSkill({ actorId: "user-2", files: [file("SKILL.md", markdown)] })).id).not.toBe("demo");
    expect(rows[0].created_by).toBe("user-1");
    expect(rows).toHaveLength(2);
  });
  it.each(["../escape", "/tmp/escape", "scripts\\escape"])("rejects unsafe path %s", async (name) => {
    await expect(importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown), file(name, "bad")] })).rejects.toThrow("不安全路径");
    expect(rows).toHaveLength(0);
  });
  it("rejects duplicate relative paths rather than replacing their content", async () => {
    await expect(importStandardSkill({ actorId: "user-1", files: [file("SKILL.md", markdown), file("main.py", "one"), file("main.py", "two")] })).rejects.toThrow("重复路径");
    expect(rows).toHaveLength(0);
  });
});
