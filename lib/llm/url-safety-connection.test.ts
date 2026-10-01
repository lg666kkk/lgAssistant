import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { createSafeProviderFetch, lookupPublicAddress } from "./url-safety";
const publicAddress = { address: "93.184.216.34", family: 4 };
beforeEach(() => { vi.clearAllMocks(); mocks.lookup.mockResolvedValue([publicAddress]); });
afterEach(() => vi.unstubAllGlobals());
function resolveSocket() {
  return new Promise((resolve, reject) => lookupPublicAddress("provider.test", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
}
describe("provider connection address validation", () => {
  it("returns exactly the validated addresses to the socket", async () => {
    await expect(resolveSocket()).resolves.toEqual([publicAddress]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects DNS rebinding between preflight and connection", async () => {
    mocks.lookup.mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => { await resolveSocket(); return new Response("ok"); }));
    await expect(createSafeProviderFetch("https://provider.test")("https://provider.test/v1/chat/completions")).rejects.toThrow("内网");
  });
  it("rejects mapped loopback addresses returned by DNS", async () => {
    mocks.lookup.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(resolveSocket()).rejects.toThrow("内网");
  });
  it("passes the validating dispatcher and forbids redirect responses", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://localhost" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(createSafeProviderFetch("https://provider.test")("https://provider.test/v1")).rejects.toThrow("重定向");
    expect(fetch).toHaveBeenCalledWith("https://provider.test/v1", expect.objectContaining({ dispatcher: expect.anything(), redirect: "manual" }));
  });
});
