import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ToolArtifactRecord = {
  id: string;
  userId: string;
  scopeId: string;
  requestId: string;
  toolCallId?: string;
  toolName: string;
  input: unknown;
  content: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type SaveToolArtifactInput = {
  userId?: string;
  scopeId?: string;
  requestId?: string;
  toolCallId?: string;
  toolName: string;
  input: unknown;
  content: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

const DEFAULT_ARTIFACT_DIR = "data/agent-artifacts";
const DEFAULT_TTL_HOURS = 7 * 24;
const DEFAULT_TEST_TTL_HOURS = 24;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

type ArtifactFile = {
  filePath: string;
  size: number;
  modifiedAtMs: number;
};

export type ArtifactCleanupResult = {
  scannedFiles: number;
  deletedExpiredFiles: number;
  deletedOverflowFiles: number;
  freedBytes: number;
  retainedBytes: number;
};

function artifactRoot() {
  return path.resolve(process.cwd(), process.env.AGENT_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIR);
}

function readPositiveEnvNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isTestArtifactPath(filePath: string) {
  return /(^|[/\\_-])test([/\\_-]|$)/i.test(filePath);
}

function safeSegment(value: string | undefined, fallback: string) {
  const normalized = value?.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function newArtifactId(toolName: string) {
  return `${safeSegment(toolName, "tool")}_${crypto.randomUUID()}`;
}

function artifactPath(input: {
  userId: string;
  scopeId: string;
  requestId: string;
  artifactId: string;
}) {
  return path.join(
    artifactRoot(),
    safeSegment(input.userId, "anonymous"),
    safeSegment(input.scopeId, "global"),
    safeSegment(input.requestId, "request"),
    `${safeSegment(input.artifactId, "artifact")}.json`,
  );
}

function artifactScopeDirectory(input: { userId: string; scopeId: string }) {
  return path.join(
    artifactRoot(),
    safeSegment(input.userId, "anonymous"),
    safeSegment(input.scopeId, "global"),
  );
}

async function findArtifactFile(input: {
  userId: string;
  scopeId: string;
  artifactId: string;
}) {
  const sessionDir = path.join(
    artifactRoot(),
    safeSegment(input.userId, "anonymous"),
    safeSegment(input.scopeId, "global"),
  );
  const safeArtifactId = safeSegment(input.artifactId, "artifact");

  const requestDirs = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const entry of requestDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionDir, entry.name, `${safeArtifactId}.json`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function serializeArtifact(record: ToolArtifactRecord) {
  return JSON.stringify(record, null, 2);
}

function fitArtifactInFileLimit(record: ToolArtifactRecord) {
  const maxBytes = readPositiveEnvNumber(
    "AGENT_ARTIFACT_MAX_FILE_BYTES",
    DEFAULT_MAX_FILE_BYTES,
  );
  const originalPayload = serializeArtifact(record);
  const originalBytes = Buffer.byteLength(originalPayload, "utf8");
  if (originalBytes <= maxBytes) return record;

  const suffix = `\n\n[artifact content truncated locally: ${originalBytes} bytes exceeded the ${maxBytes} byte limit]`;
  const compactRecord: ToolArtifactRecord = {
    ...record,
    data: undefined,
    metadata: {
      artifactStorageTruncated: true,
      originalBytes,
    },
  };

  if (Buffer.byteLength(serializeArtifact({ ...compactRecord, content: suffix }), "utf8") > maxBytes) {
    compactRecord.input = { omitted: true };
  }
  if (Buffer.byteLength(serializeArtifact({ ...compactRecord, content: suffix }), "utf8") > maxBytes) {
    compactRecord.metadata = {
      artifactStorageTruncated: true,
      originalBytes,
    };
  }

  let low = 0;
  let high = record.content.length;
  let content = suffix;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${record.content.slice(0, middle)}${suffix}`;
    if (Buffer.byteLength(serializeArtifact({ ...compactRecord, content: candidate }), "utf8") <= maxBytes) {
      content = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    ...compactRecord,
    content,
  };
}

async function listArtifactFiles(directory: string): Promise<ArtifactFile[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: ArtifactFile[] = [];

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(filePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const details = await stat(filePath).catch(() => undefined);
    if (!details) continue;
    files.push({
      filePath,
      size: details.size,
      modifiedAtMs: details.mtimeMs,
    });
  }

  return files;
}

export async function cleanupToolArtifacts(input: {
  now?: number;
} = {}): Promise<ArtifactCleanupResult> {
  const now = input.now ?? Date.now();
  const normalTtlMs = readPositiveEnvNumber(
    "AGENT_ARTIFACT_TTL_HOURS",
    DEFAULT_TTL_HOURS,
  ) * 60 * 60 * 1000;
  const testTtlMs = readPositiveEnvNumber(
    "AGENT_ARTIFACT_TEST_TTL_HOURS",
    DEFAULT_TEST_TTL_HOURS,
  ) * 60 * 60 * 1000;
  const maxTotalBytes = readPositiveEnvNumber(
    "AGENT_ARTIFACT_MAX_TOTAL_BYTES",
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const files = await listArtifactFiles(artifactRoot());
  const result: ArtifactCleanupResult = {
    scannedFiles: files.length,
    deletedExpiredFiles: 0,
    deletedOverflowFiles: 0,
    freedBytes: 0,
    retainedBytes: 0,
  };
  const retained: ArtifactFile[] = [];

  for (const file of files) {
    const ttlMs = isTestArtifactPath(file.filePath) ? testTtlMs : normalTtlMs;
    if (now - file.modifiedAtMs > ttlMs) {
      await rm(file.filePath, { force: true }).catch(() => undefined);
      result.deletedExpiredFiles += 1;
      result.freedBytes += file.size;
      continue;
    }
    retained.push(file);
    result.retainedBytes += file.size;
  }

  for (const file of retained.sort((a, b) => a.modifiedAtMs - b.modifiedAtMs)) {
    if (result.retainedBytes <= maxTotalBytes) break;
    await rm(file.filePath, { force: true }).catch(() => undefined);
    result.deletedOverflowFiles += 1;
    result.freedBytes += file.size;
    result.retainedBytes -= file.size;
  }

  return result;
}

/**
 * 删除一个用户在单个会话 scope 下的所有工具结果。
 * sessionId 是 artifact 的 scopeId，因此不会触及该用户的其他会话目录。
 */
export async function deleteToolArtifactsForScope(input: {
  userId: string;
  scopeId: string;
}): Promise<void> {
  const scopeDir = artifactScopeDirectory(input);
  await rm(scopeDir, { recursive: true, force: true });
}

export async function saveToolArtifact(input: SaveToolArtifactInput): Promise<ToolArtifactRecord> {
  const now = new Date().toISOString();
  const record = fitArtifactInFileLimit({
    id: newArtifactId(input.toolName),
    userId: input.userId ?? "anonymous",
    scopeId: input.scopeId ?? "global",
    requestId: input.requestId ?? "request",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.input,
    content: input.content,
    data: input.data,
    metadata: input.metadata,
    createdAt: now,
  });
  const filePath = artifactPath({
    userId: record.userId,
    scopeId: record.scopeId,
    requestId: record.requestId,
    artifactId: record.id,
  });

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeArtifact(record), "utf8");
  void cleanupToolArtifacts().catch((error) =>
    console.error("[artifact] 清理本地 artifact 失败:", error),
  );
  return record;
}

export async function readToolArtifact(input: {
  userId?: string;
  scopeId?: string;
  artifactId: string;
}): Promise<ToolArtifactRecord | undefined> {
  const safeArtifactId = safeSegment(input.artifactId, "");
  if (!safeArtifactId || safeArtifactId !== input.artifactId) return undefined;

  const filePath = await findArtifactFile({
    userId: input.userId ?? "anonymous",
    scopeId: input.scopeId ?? "global",
    artifactId: safeArtifactId,
  });
  if (!filePath) return undefined;

  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ToolArtifactRecord;
}
