import { Agent } from "undici";
import { assertPublicProviderUrl, createSafeProviderFetch } from "./url-safety";

// Loopback access is automatic in development and opt-in on production servers.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localDispatcher = new Agent({ connections: 3 });

function normalizeUrl(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("模型地址必须是 HTTP/HTTPS，且不能包含凭据、查询参数或片段");
  }
  return url.toString().replace(/\/+$/, "");
}

export function isLocalLlmBaseUrl(value: string) {
  const normalized = normalizeUrl(value);
  const allowLoopback = process.env.LLM_ALLOW_LOCALHOST === undefined
    ? process.env.NODE_ENV === "development"
    : process.env.LLM_ALLOW_LOCALHOST === "true";
  if (allowLoopback && loopbackHostnames.has(new URL(normalized).hostname)) return true;
  const allowed = (process.env.LLM_LOCAL_BASE_URLS ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  return allowed.some((entry) => normalizeUrl(entry) === normalized);
}

export async function assertLlmProviderUrl(value: string) {
  const normalized = normalizeUrl(value);
  if (isLocalLlmBaseUrl(normalized)) return normalized;
  try {
    return await assertPublicProviderUrl(normalized);
  } catch (error) {
    if (error instanceof Error && /本机|内网|保留地址/.test(error.message)) {
      throw new Error("本地模型地址未获授权。本机访问可设置 LLM_ALLOW_LOCALHOST=true；内网地址请加入 LLM_LOCAL_BASE_URLS，然后重新加载应用配置");
    }
    throw error;
  }
}

export function createLlmProviderFetch(baseUrl: string, timeoutMs = 60_000): typeof fetch {
  const normalized = normalizeUrl(baseUrl);
  const publicFetch = createSafeProviderFetch(normalized, timeoutMs);
  return async (input, init) => {
    if (!isLocalLlmBaseUrl(normalized)) return publicFetch(input, init);
    const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const base = new URL(normalized);
    // Limit trusted local access to this exact API prefix, including its port.
    if (requestUrl.origin !== base.origin
      || !requestUrl.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`)
      || requestUrl.username || requestUrl.password) {
      throw new Error("本地模型请求超出了配置的 API 地址");
    }
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(Math.max(timeoutMs, 180_000));
    const options: RequestInit & { dispatcher: Agent } = {
      ...init,
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      redirect: "manual",
      dispatcher: localDispatcher,
    };
    const response = await fetch(input, options);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Provider 返回了不允许的重定向");
    }
    return response;
  };
}
