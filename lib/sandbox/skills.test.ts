import { describe, expect, it } from "vitest";
import { deleteSkillDefinition, publishSkillVersion, upsertSkillDefinition } from "./skills";

describe("sandbox skill configuration validation", () => {
  it("rejects unsafe skill identifiers before database access", async () => {
    await expect(upsertSkillDefinition({
      id: "../escape",
      name: "Unsafe",
      enabled: true,
      actorId: "admin-1",
    })).rejects.toThrow("Skill ID");
  });

  it("rejects an unconfigured E2B template before publication", async () => {
    await expect(publishSkillVersion({
      skillId: "markdown-check",
      version: "1.0.0",
      runtime: "node",
      entrypoint: ["node", "scripts/run.mjs"],
      profileId: "skill-trusted",
      templateId: "unconfigured-template",
      bundleBase64: Buffer.from("bundle").toString("base64"),
      inputSchema: "schemas/input.json",
      outputSchema: "schemas/output.json",
      actorId: "admin-1",
    })).rejects.toThrow("E2B 模板");
  });

  it("rejects unsafe delete identifiers before database access", async () => {
    await expect(deleteSkillDefinition({ id: "../escape", actorId: "admin-1" }))
      .rejects.toThrow("Skill ID");
  });
});
