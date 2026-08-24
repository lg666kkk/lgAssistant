import { describe, expect, it, vi } from "vitest";
import { createDeepSeekThinkingFetch, toAIMessage } from "./model-provider";

describe("DeepSeek thinking request adapter", () => {
  it("maps an internal image block to the AI SDK image part", () => {
    const message = toAIMessage({
      role: "user",
      content: [
        { type: "text", text: "描述图片" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ],
    } as never, new Map());

    expect(message.content).toEqual([
      { type: "text", text: "描述图片" },
      { type: "image", image: "aGVsbG8=", mediaType: "image/png" },
    ]);
  });

  it("enables thinking and carries reasoning across tool continuations", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("ok"));
    const thinkingFetch = createDeepSeekThinkingFetch(
      baseFetch as unknown as typeof fetch,
      [
        { role: "user", content: "明天天气如何" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "date-1", name: "get_date", input: {} }],
          reasoning_content: "需要先查询日期。",
        } as never,
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "date-1", content: "2026-08-17" }],
        },
      ],
    );

    await thinkingFetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        temperature: 0.7,
        messages: [
          { role: "user", content: "明天天气如何" },
          { role: "assistant", content: null, tool_calls: [{ id: "date-1" }] },
          { role: "tool", tool_call_id: "date-1", content: "2026-08-17" },
        ],
      }),
    });

    const request = JSON.parse(String(baseFetch.mock.calls[0][1]?.body));
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.reasoning_effort).toBe("high");
    expect(request.temperature).toBeUndefined();
    expect(request.messages[1].reasoning_content).toBe("需要先查询日期。");
  });

  it("leaves unrelated requests untouched", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("ok"));
    const thinkingFetch = createDeepSeekThinkingFetch(
      baseFetch as unknown as typeof fetch,
    );

    await thinkingFetch("https://example.com/health", {
      method: "POST",
      body: "plain-body",
    });

    expect(baseFetch.mock.calls[0][1]?.body).toBe("plain-body");
  });

  it("observes reasoning_content before the AI SDK schema parses the stream", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n',
      '\ndata: {"choices":[{"delta":{"reasoning_content":"再回答"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }));
    const reasoning: string[] = [];
    const thinkingFetch = createDeepSeekThinkingFetch(
      baseFetch as unknown as typeof fetch,
      [],
      (text) => reasoning.push(text),
    );

    const response = await thinkingFetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    await response.text();

    expect(reasoning).toEqual(["先分析", "再回答"]);
  });
});
