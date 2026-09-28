import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import Ajv from "ajv";
import tar from "tar-stream";

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 1000;

export async function readSkillBundle(bundle: Buffer, expectedSha256: string): Promise<Map<string, Buffer>> {
  if (bundle.length > MAX_BUNDLE_BYTES || createHash("sha256").update(bundle).digest("hex") !== expectedSha256) {
    throw new Error("Skill Bundle 大小或 SHA-256 不匹配");
  }
  const files = new Map<string, Buffer>();
  const extractor = tar.extract();
  await new Promise<void>((resolve, reject) => {
    let total = 0;
    let count = 0;
    let invalid: Error | null = null;
    extractor.on("entry", (header, stream, next) => {
      const name = header.name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!isSafePath(name) || name === "input.json" || name === "result.json" || name.startsWith(".git/")) {
        invalid = new Error(`Bundle 包含不安全路径：${header.name}`);
        stream.resume();
        stream.on("end", next);
        return;
      }
      if (header.type === "directory") {
        stream.resume();
        stream.on("end", next);
        return;
      }
      count += 1;
      total += header.size;
      if (header.type !== "file" || count > MAX_FILES || total > MAX_BUNDLE_BYTES || files.has(name)) {
        invalid = new Error(`Bundle 包含不支持的文件：${header.name}`);
        stream.resume();
        stream.on("end", next);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => { chunks.push(Buffer.from(chunk as Uint8Array)); });
      stream.on("end", () => {
        files.set(name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extractor.on("finish", () => invalid ? reject(invalid) : resolve());
    extractor.on("error", reject);
    Readable.from(bundle).pipe(extractor);
  });
  return files;
}

export function validateSkillJSON(schemaBytes: Buffer, value: unknown): void {
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  rejectExternalRefs(schema);
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`JSON Schema 校验失败：${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

function isSafePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function rejectExternalRefs(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectExternalRefs);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#"))) {
        throw new Error("JSON Schema 不允许外部 $ref");
      }
      rejectExternalRefs(child);
    }
  }
}
