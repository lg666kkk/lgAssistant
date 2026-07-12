import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  deleteToolArtifactsForScope,
  saveToolArtifact,
} from "./artifact-store";

const originalArtifactDir = process.env.AGENT_ARTIFACT_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  if (originalArtifactDir === undefined) {
    delete process.env.AGENT_ARTIFACT_DIR;
  } else {
    process.env.AGENT_ARTIFACT_DIR = originalArtifactDir;
  }
});

describe("deleteToolArtifactsForScope", () => {
  it("only removes artifacts belonging to the requested session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-artifacts-"));
    temporaryDirectories.push(root);
    process.env.AGENT_ARTIFACT_DIR = root;

    await saveToolArtifact({
      userId: "user-1",
      scopeId: "session-a",
      requestId: "request-1",
      toolName: "web_fetch",
      input: {},
      content: "first session",
    });
    await saveToolArtifact({
      userId: "user-1",
      scopeId: "session-b",
      requestId: "request-2",
      toolName: "web_fetch",
      input: {},
      content: "second session",
    });

    await deleteToolArtifactsForScope({ userId: "user-1", scopeId: "session-a" });

    await expect(stat(path.join(root, "user-1", "session-a"))).rejects.toThrow();
    await expect(stat(path.join(root, "user-1", "session-b"))).resolves.toBeDefined();
  });
});
