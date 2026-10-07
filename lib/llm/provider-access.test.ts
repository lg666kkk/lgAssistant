import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLlmProviderUrl, createLlmProviderFetch, isLocalLlmBaseUrl } from "./provider-access";
import { assertPublicProviderUrl } from "./url-safety";
import { discoverOpenAICompatibleModels } from "./model-discovery";
import { testUserLlmConnection } from "./connection-test";
import type { ResolvedUserLlmModel } from "./types";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("LLM_ALLOW_LOCALHOST", undefined);
  vi.stubEnv("LLM_LOCAL_BASE_URLS", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const baseUrl = "http://127.0.0.1:11434/v1";

describe("trusted local LLM access", () => {
  it("allows loopback addresses on any port during development", async () => {
    vi.stubEnv("LLM_LOCAL_BASE_URLS", undefined);
    vi.stubEnv("NODE_ENV", "development");
    await expect(assertLlmProviderUrl(`${baseUrl}/`)).resolves.toBe(baseUrl);
    await expect(assertLlmProviderUrl("http://localhost:11434/v1")).resolves.toBe("http://localhost:11434/v1");
    for (const url of ["http://127.0.0.1:8008/v1", "http://localhost:9000/api/v1", "http://[::1]:65535/v1"]) {
      await expect(assertLlmProviderUrl(url)).resolves.toBe(url);
    }
    // An old endpoint allowlist must not reintroduce a port restriction.
    vi.stubEnv("LLM_LOCAL_BASE_URLS", baseUrl);
    await expect(assertLlmProviderUrl("http://127.0.0.1:5000/v1")).resolves.toBe("http://127.0.0.1:5000/v1");
    vi.stubEnv("LLM_LOCAL_BASE_URLS", undefined);
    vi.stubEnv("NODE_ENV", "production");
    await expect(assertLlmProviderUrl(baseUrl)).rejects.toThrow();
  });

  it("requires an exact server allowlist and leaves other services restricted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_LOCAL_BASE_URLS", `${baseUrl}, http://10.0.0.2:11434/v1`);
    await expect(assertLlmProviderUrl("http://10.0.0.2:11434/v1/")).resolves.toBe("http://10.0.0.2:11434/v1");
    await expect(assertLlmProviderUrl("http://10.0.0.3:11434/v1")).rejects.toThrow();
    await expect(assertPublicProviderUrl(baseUrl)).rejects.toThrow();
    vi.stubEnv("LLM_LOCAL_BASE_URLS", "");
    expect(isLocalLlmBaseUrl(baseUrl)).toBe(false);
  });

  it("supports arbitrary loopback ports with one production switch", async () => {
    const customUrl = "http://127.0.0.1:8008/v1";
    vi.stubEnv("NODE_ENV", "production");
    await expect(assertLlmProviderUrl(customUrl)).rejects.toThrow("LLM_ALLOW_LOCALHOST");
    vi.stubEnv("LLM_ALLOW_LOCALHOST", "true");
    await expect(assertLlmProviderUrl(`${customUrl}/`)).resolves.toBe(customUrl);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLlmProviderFetch(customUrl)(`${customUrl}/models`)).resolves.toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("can disable automatic loopback access and still blocks untrusted private hosts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LLM_ALLOW_LOCALHOST", "false");
    await expect(assertLlmProviderUrl(baseUrl)).rejects.toThrow();
    vi.stubEnv("LLM_ALLOW_LOCALHOST", "true");
    for (const url of ["http://10.0.0.2:8008/v1", "http://169.254.169.254/v1", "http://localhost.example.com:8008/v1"]) {
      expect(isLocalLlmBaseUrl(url)).toBe(false);
    }
    await expect(assertPublicProviderUrl(baseUrl)).rejects.toThrow();
  });

  it.each([
    "http://127.0.0.1:11434/v1/../../api/delete",
    "http://127.0.0.1:11434/v10/models",
    "http://127.0.0.1:6379/v1/models",
    "http://169.254.169.254/latest/meta-data",
    "http://user:password@127.0.0.1:11434/v1/models",
  ])("rejects local requests outside the trusted API: %s", async (url) => {
    vi.stubEnv("LLM_LOCAL_BASE_URLS", baseUrl);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLlmProviderFetch(baseUrl)(url)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forbids redirects and preserves caller cancellation", async () => {
    vi.stubEnv("LLM_LOCAL_BASE_URLS", baseUrl);
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 302 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLlmProviderFetch(baseUrl)(`${baseUrl}/models`, { signal: controller.signal })).rejects.toThrow("重定向");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual", signal: expect.objectContaining({ aborted: true }) }));
  });

  it("discovers Ollama models and sends an OpenAI-compatible connection test", async () => {
    vi.stubEnv("LLM_LOCAL_BASE_URLS", baseUrl);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "local-model:latest", owned_by: "library" }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "OK" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(discoverOpenAICompatibleModels({ baseUrl, apiKey: "ollama" })).resolves.toEqual([{ id: "local-model:latest", ownedBy: "library" }]);
    await expect(testUserLlmConnection({ baseUrl, apiKey: "ollama", modelId: "local-model:latest" } as ResolvedUserLlmModel)).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(fetchMock.mock.calls[1][0]).toBe(`${baseUrl}/chat/completions`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({ model: "local-model:latest", stream: false }));
  });
});
