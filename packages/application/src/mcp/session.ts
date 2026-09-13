import type { ExternalToolsPort } from "./ports";

/** Owns cancellation for both the HTTP request and response-body cancellation. */
export async function openExternalToolSession(input: {
  port?: ExternalToolsPort;
  userId: string;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  let session: Awaited<ReturnType<ExternalToolsPort["open"]>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    input.signal.removeEventListener("abort", abort);
    return closing ??= Promise.resolve().then(() => session?.close()).catch(() => {
      // Never expose transport errors (which may contain credentials).
      console.warn("[mcp] 关闭外部工具连接失败");
    });
  };
  const abort = () => {
    controller.abort();
    // open() owns partially initialized clients until it returns.
    if (session) void close();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    session = await input.port?.open({ userId: input.userId, signal: controller.signal });
    controller.signal.throwIfAborted();
    return { tools: session?.tools ?? [], signal: controller.signal, close, abort };
  } catch (error) {
    await close();
    throw error;
  }
}
