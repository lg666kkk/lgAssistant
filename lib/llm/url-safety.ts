import { Agent } from "undici";
import { isIP, type LookupFunction } from "node:net";
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
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // WHATWG normalizes dotted mapped addresses to two hexadecimal IPv4 groups.
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
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
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalVersion = isIP(hostname);
  const addresses = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Base URL 无法解析");
  assertPublicAddresses(addresses);
  return normalized;
}

function assertPublicAddresses(addresses: Array<{ address: string; family: number }>) {
  if (!addresses.length || addresses.some((entry) =>
    entry.family === 4 ? isBlockedIpv4(entry.address)
      : entry.family === 6 ? isBlockedIpv6(entry.address) : true,
  )) throw new Error("Base URL 解析到了本机、内网或保留地址");
}

/** The socket receives exactly the DNS result that was validated, preventing DNS rebinding. */
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    assertPublicAddresses(addresses);
    const family = typeof options.family === "number" ? options.family : 0;
    const candidates = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (!candidates.length) throw new Error("Base URL 无法解析到所需地址族");
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  }).catch((error: Error) => callback(error, []));
};

// One bounded connection pool shared across requests; DNS is revalidated for each new socket.
const publicDispatcher = new Agent({ connect: { lookup: lookupPublicAddress }, connections: 3 });

export function createSafeProviderFetch(baseUrl: string, timeoutMs = 60_000): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (requestUrl.origin !== origin) throw new Error("Provider 请求不能跳转到其他来源");
    await assertPublicProviderUrl(requestUrl.toString());
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const options: RequestInit & { dispatcher: Agent } = {
      ...init, signal, redirect: "manual", dispatcher: publicDispatcher,
    };
    const response = await fetch(input, options);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Provider 返回了不允许的重定向");
    }
    return response;
  };
}
