import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveUserLlmModel } = vi.hoisted(() => ({
  resolveUserLlmModel: vi.fn(),
}));

import { parseChatRequest } from "./request";

describe("parseChatRequest", () => {
  beforeEach(() => {
    resolveUserLlmModel.mockReset();
    resolveUserLlmModel.mockResolvedValue({
      id: "model-1",
      supportsImages: false,
      supportsTools: true,
      contextWindow: 32_000,
    });
  });

  it("rejects an invalid JSON body before resolving a model", async () => {
    const result = await parseChatRequest(new Request("http://localhost/api/chat", {
      method: "POST",
      body: "{invalid",
    }), "user-1", resolveUserLlmModel);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(resolveUserLlmModel).not.toHaveBeenCalled();
  });

  it("normalizes a valid single-message session command", async () => {
    const result = await parseChatRequest(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        model: "model-1",
        enableWebSearch: false,
        messages: [{ role: "user", content: "你好" }],
      }),
    }), "user-1", resolveUserLlmModel);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      sessionId: "session-1",
      enableWebSearch: false,
      selectedModel: "model-1",
      requestTextMessages: [{ role: "user", content: "你好" }],
    });
    expect(resolveUserLlmModel).toHaveBeenCalledWith("user-1", "model-1");
  });

  it("rejects images for a model without vision support", async () => {
    const result = await parseChatRequest(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: "看图",
          attachments: [{
            id: "image-1",
            name: "image.png",
            mediaType: "image/png",
            size: 4,
            dataUrl: "data:image/png;base64,aGVsbA==",
          }],
        }],
      }),
    }), "user-1", resolveUserLlmModel);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(await result.response.json()).toEqual({
        error: "当前模型未启用图片输入能力，请选择视觉模型",
      });
    }
  });
});
