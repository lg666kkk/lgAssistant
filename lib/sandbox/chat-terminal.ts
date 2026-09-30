import { createHash } from "node:crypto";
import { CommandExitError, Sandbox, SandboxNotFoundError } from "e2b";
import { createRedisClient } from "@/lib/platform/redis";
import { getE2BApiKey } from "./config";

const WORKSPACE = "/home/user/workspace";
const SESSION_SECONDS = 30 * 60;
const COMMAND_MS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;
const NODE_BIN = "/home/user/.chat-terminal/node_modules/node/bin";
const NPM_BIN = "/home/user/.chat-terminal/node_modules/.bin";
const redis = createRedisClient({ errorLabel: "ChatTerminal" });

function sessionKey(userId: string, scopeId: string) {
  const id = createHash("sha256").update(`${userId}\0${scopeId}`).digest("hex");
  return `chat-terminal:${id}`;
}

function preview(value: string) {
  const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return clean.length > MAX_OUTPUT_CHARS
    ? `${clean.slice(0, MAX_OUTPUT_CHARS)}\n[输出已截断]`
    : clean;
}

export async function runChatTerminalCommand(input: {
  userId: string;
  scopeId: string;
  command: string;
  cwd?: string;
  signal?: AbortSignal;
}) {
  const command = input.command.trim();
  if (!command || command.length > 4_000 || command.includes("\0")) {
    throw new Error("命令必须为 1–4000 个字符且不能包含空字节");
  }
  const cwd = input.cwd?.trim() || WORKSPACE;
  if (!cwd.startsWith("/") || cwd.includes("\0")) throw new Error("工作目录必须是沙盒内的绝对路径");
  input.signal?.throwIfAborted();

  const apiKey = await getE2BApiKey(input.userId);
  const key = sessionKey(input.userId, input.scopeId);
  const previousId = await redis.get(key);
  let sandbox: Sandbox | undefined;
  let reset = false;
  if (previousId) {
    try {
      sandbox = await Sandbox.connect(previousId, { apiKey });
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
      await redis.del(key);
      reset = true;
    }
  }
  if (!sandbox) {
    sandbox = await Sandbox.create(process.env.E2B_CODING_TEMPLATE_ID ?? "base", {
      apiKey,
      allowInternetAccess: true,
      timeoutMs: SESSION_SECONDS * 1000,
    });
    try {
      await sandbox.files.makeDir(WORKSPACE);
      const version = await sandbox.commands.run("node --version", { cwd: WORKSPACE, timeoutMs: 10_000 });
      const match = /^v(\d+)\.(\d+)\./.exec(version.stdout.trim());
      if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 20)) {
        await sandbox.commands.run("npm install --prefix /home/user/.chat-terminal --no-audit --no-fund node@22.21.0 npm@10.9.4", {
          cwd: WORKSPACE,
          timeoutMs: 120_000,
        });
      }
      await redis.setex(key, SESSION_SECONDS, sandbox.sandboxId);
    } catch (error) {
      await Sandbox.kill(sandbox.sandboxId, { apiKey, requestTimeoutMs: 10_000 }).catch(() => undefined);
      throw error;
    }
  } else {
    await Sandbox.setTimeout(sandbox.sandboxId, SESSION_SECONDS * 1000, { apiKey });
    await redis.setex(key, SESSION_SECONDS, sandbox.sandboxId);
  }

  input.signal?.throwIfAborted();
  try {
    const result = await sandbox.commands.run(`export PATH=${NPM_BIN}:${NODE_BIN}:$PATH; ${command}`, {
      cwd,
      timeoutMs: COMMAND_MS,
      signal: input.signal,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: preview(result.stdout),
      stderr: preview(result.stderr),
      sandboxId: sandbox.sandboxId,
      reset,
      cwd,
    };
  } catch (error) {
    if (!(error instanceof CommandExitError)) throw error;
    return {
      ok: false,
      exitCode: error.exitCode,
      stdout: preview(error.stdout),
      stderr: preview(error.stderr),
      sandboxId: sandbox.sandboxId,
      reset,
      cwd,
    };
  }
}

export async function deleteChatTerminalSession(input: { userId: string; scopeId: string }) {
  const key = sessionKey(input.userId, input.scopeId);
  const sandboxId = await redis.get(key);
  if (!sandboxId) return;
  const apiKey = await getE2BApiKey(input.userId);
  await Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs: 10_000 }).catch((error) => {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  });
  await redis.del(key);
}
