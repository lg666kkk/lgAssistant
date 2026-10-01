import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";

type LeaseClient = Pick<Redis, "set" | "eval">;
let redis: Redis | undefined;
function client(): LeaseClient {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000,
    });
    redis.on("error", () => console.warn("[session-lease] Redis unavailable"));
  }
  return redis;
}
const TTL_MS = 90_000;
const RENEW = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

/** Serialize chat and confirmation continuations through the entire response stream. */
export async function withChatSessionLease(
  request: Request,
  userId: string,
  handler: (request: Request) => Promise<Response>,
  connection?: LeaseClient,
): Promise<Response> {
  let sessionId: unknown;
  try { sessionId = (await request.clone().json())?.sessionId; } catch { /* The request parser returns 400. */ }
  if (typeof sessionId !== "string" || !sessionId) return handler(request);
  const db = connection ?? client();
  const key = `chat-session-lease:${createHash("sha256").update(`${userId}\0${sessionId}`).digest("hex")}`;
  const owner = randomUUID();
  try {
    if (!await db.set(key, owner, "PX", TTL_MS, "NX")) {
      return Response.json({ error: "该会话正在处理其他请求，请稍后重试" }, { status: 409 });
    }
  } catch {
    return Response.json({ error: "暂时无法锁定会话，请稍后重试" }, { status: 503 });
  }
  const controller = new AbortController();
  let released = false;
  let onAbort: (() => void) | undefined;
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    await db.eval(RELEASE, 1, key, owner).catch(() => console.warn("[session-lease] release failed"));
  };
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void db.eval(RENEW, 1, key, owner, TTL_MS).then((result) => {
      if (result !== 1) controller.abort(new Error("会话锁已失效"));
    }).catch((error) => controller.abort(error)).finally(() => { renewing = false; });
  }, 20_000);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const response = await handler(new Request(request, { signal }));
    if (!response.body) { await release(); return response; }
    const reader = response.body.getReader();
    onAbort = () => { void reader.cancel(signal.reason).catch(() => {}).finally(release); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) { await release(); output.close(); }
          else output.enqueue(value);
        } catch (error) {
          controller.abort(error);
          await reader.cancel(error).catch(() => {});
          await release();
          output.error(error);
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
        await release();
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { await release(); throw error; }
}
