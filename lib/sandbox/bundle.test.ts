import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import tar from "tar-stream";
import { readSkillBundle, validateSkillJSON } from "./bundle";

async function makeBundle(name: string, contents: string): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.entry({ name }, contents);
  pack.finalize();
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe("E2B Skill bundle", () => {
  it("reads a digest-bound file", async () => {
    const bundle = await makeBundle("scripts/run.mjs", "console.log('ok')");
    const digest = createHash("sha256").update(bundle).digest("hex");
    const files = await readSkillBundle(bundle, digest);
    expect(files.get("scripts/run.mjs")?.toString()).toBe("console.log('ok')");
  });

  it("rejects traversal and changed bundles", async () => {
    const bundle = await makeBundle("../escape", "bad");
    const digest = createHash("sha256").update(bundle).digest("hex");
    await expect(readSkillBundle(bundle, digest)).rejects.toThrow("不安全路径");
    await expect(readSkillBundle(bundle, "0".repeat(64))).rejects.toThrow("SHA-256");
  });

  it("rejects external schema references", () => {
    expect(() => validateSkillJSON(Buffer.from('{"$ref":"https://example.com/schema"}'), {}))
      .toThrow("外部 $ref");
  });
});
