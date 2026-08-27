import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const blockedHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

function isBlockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd");
}

export function normalizeProviderBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Base URL 只允许 HTTP 或 HTTPS");
  }
  if (url.username || url.password) throw new Error("Base URL 不能包含用户名或密码");
  if (url.hash || url.search) throw new Error("Base URL 不能包含查询参数或片段");
  if (blockedHostnames.has(url.hostname.toLowerCase()) || url.hostname.endsWith(".local")) {
    throw new Error("Base URL 不能指向本机或内网主机");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export async function assertPublicProviderUrl(value: string) {
  const normalized = normalizeProviderBaseUrl(value);
  const url = new URL(normalized);
  const literalVersion = isIP(url.hostname);
  const addresses = literalVersion
    ? [{ address: url.hostname, family: literalVersion }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Base URL 无法解析");
  for (const entry of addresses) {
    if (
      (entry.family === 4 && isBlockedIpv4(entry.address))
      || (entry.family === 6 && isBlockedIpv6(entry.address))
    ) {
      throw new Error("Base URL 解析到了本机、内网或保留地址");
    }
  }
  return normalized;
}

export function createSafeProviderFetch(baseUrl: string, timeoutMs = 60_000): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (requestUrl.origin !== origin) throw new Error("Provider 请求不能跳转到其他来源");
    await assertPublicProviderUrl(requestUrl.toString());
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(input, { ...init, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Provider 返回了不允许的重定向");
    }
    return response;
  };
}

