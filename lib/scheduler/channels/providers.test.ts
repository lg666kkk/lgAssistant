import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWeComWebhookUrl } from "./config";
import { sendNotification } from "./providers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notification providers", () => {
  it("checks ownership before each chunk and stops after lease loss", async () => {
    const transport = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", transport);
    const beforeSend = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lease lost"));
    await expect(sendNotification({
      provider: "telegram", userId: "user-1", telegram: { botToken: "test", chatId: "test" },
    }, "x".repeat(8001), beforeSend)).rejects.toThrow("lease lost");
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("only accepts the official WeCom group robot endpoint", () => {
    expect(validateWeComWebhookUrl(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
    )).toContain("qyapi.weixin.qq.com/cgi-bin/webhook/send");
    expect(() => validateWeComWebhookUrl("https://example.com/hook?key=abc"))
      .toThrow("官方 HTTPS Webhook URL");
  });

  it("sends Telegram text without exposing credentials in the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 42 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendNotification({
      provider: "telegram",
      userId: "user-1",
      telegram: { botToken: "123:abcdefghijklmnopqrstuvwxyz", chatId: "456" },
    }, "日报")).resolves.toEqual({ messageId: "42" });

    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toEqual({ chat_id: "456", text: "日报" });
  });

  it("surfaces provider errors for delivery retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errcode: 93000,
      errmsg: "invalid webhook",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(sendNotification({
      provider: "wecom",
      userId: "user-1",
      wecom: { webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" },
    }, "日报")).rejects.toThrow("invalid webhook");
  });
});
