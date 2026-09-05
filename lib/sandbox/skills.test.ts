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

  it("rejects mutable images before publication", async () => {
    await expect(publishSkillVersion({
      skillId: "markdown-check",
      version: "1.0.0",
      runtime: "node",
      entrypoint: ["node", "scripts/run.mjs"],
      profileId: "skill-trusted",
      imageDigest: "node:latest",
      bundleBase64: Buffer.from("bundle").toString("base64"),
      inputSchema: "schemas/input.json",
      outputSchema: "schemas/output.json",
      actorId: "admin-1",
    })).rejects.toThrow("sha256 digest");
  });

  it("rejects unsafe delete identifiers before database access", async () => {
    await expect(deleteSkillDefinition({ id: "../escape", actorId: "admin-1" }))
      .rejects.toThrow("Skill ID");
  });
});
