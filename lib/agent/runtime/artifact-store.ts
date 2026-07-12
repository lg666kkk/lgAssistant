import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

function artifactRoot() {
  return path.resolve(process.cwd(), process.env.AGENT_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIR);
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

export async function saveToolArtifact(input: SaveToolArtifactInput): Promise<ToolArtifactRecord> {
  const now = new Date().toISOString();
  const record: ToolArtifactRecord = {
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
  };
  const filePath = artifactPath({
    userId: record.userId,
    scopeId: record.scopeId,
    requestId: record.requestId,
    artifactId: record.id,
  });

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
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

