import { describe, expect, it } from "vitest";
import { skillReference, matchSlashCommands, parseSlashCommand, skillSlashQuery, searchInstalledSkills, type InstalledSkill } from "./slash-commands";

describe("slash commands", () => {
  it("offers compaction and direct Skill name queries", () => {
    expect(matchSlashCommands("/")).toHaveLength(1);
    expect(matchSlashCommands("/co")[0]?.name).toBe("/compact");
    expect(matchSlashCommands("/find PDF")).toEqual([]);
    expect(parseSlashCommand("路径 /compact")).toBeNull();
    expect(parseSlashCommand("/finder")).toBeNull();
  });
  it("accepts an empty command or a multiline discovery need", () => {
    expect(parseSlashCommand(" /compact ")).toEqual({ name: "compact", args: "" });
    expect(parseSlashCommand("/find PDF")).toBeNull();
    expect(skillSlashQuery("/fi")).toBe("fi");
    expect(skillSlashQuery("/compact ")).toBeNull();
  });

  const items: InstalledSkill[] = [
    { id: "pdf-reader", name: "PDF Reader", description: "读取和处理文档", enabled: true },
    { id: "find-skills", name: "find-skills", description: "发现技能", enabled: true },
    { id: "disabled", name: "Document PDF", description: "文档", enabled: false },
  ];
  it("matches Skill names, IDs and descriptions, ignoring case and separators", () => {
    expect(searchInstalledSkills(items, "PDF_reader")[0]?.id).toBe("pdf-reader");
    expect(searchInstalledSkills(items, "读取 文档")[0]?.id).toBe("pdf-reader");
    expect(searchInstalledSkills(items, "fnsk")[0]?.id).toBe("find-skills");
    expect(searchInstalledSkills(items, "fi")[0]?.name).toBe("find-skills");
    expect(searchInstalledSkills(items, "不存在")).toEqual([]);
  });
  it("lists installed entries for an empty query and ranks name prefixes before substrings", () => {
    expect(searchInstalledSkills(items, "")).toEqual(items);
    expect(searchInstalledSkills(items, "pdf").map((item) => item.id)).toEqual(["pdf-reader", "disabled"]);
    expect(skillReference(items[0])).toContain("ID: pdf-reader");
    expect(skillReference(items[0])).toContain("本次任务请使用我选择的已安装 Skill「PDF Reader」");
    expect(skillReference(items[0])).toContain("先读取该 Skill 的说明");
    expect(searchInstalledSkills([{ ...items[1], name: "other", id: "other", description: "first item note document sort knowledge" }], "find-sk")).toEqual([]);
  });
});
