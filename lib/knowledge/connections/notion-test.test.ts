import { afterEach, describe, expect, it, vi } from "vitest";
import { testNotionConnection } from "./notion-test";

describe("testNotionConnection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates against the fixed Notion current-user endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer ntn_test_token_1234567890",
        "Notion-Version": "2022-06-28",
      });
      return new Response(JSON.stringify({ name: "Personal Assistant", type: "bot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testNotionConnection("ntn_test_token_1234567890");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/users/me",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result).toMatchObject({
      ok: true,
      integrationName: "Personal Assistant",
      integrationType: "bot",
    });
  });

  it("surfaces the Notion API error without returning the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "unauthorized",
      message: "API token is invalid.",
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(testNotionConnection("ntn_invalid_token_1234567890"))
      .rejects.toThrow("Notion 返回 401: API token is invalid.");
  });
});
