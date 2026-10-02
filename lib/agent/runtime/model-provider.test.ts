import { describe, expect, it, vi } from "vitest";
import { createDeepSeekThinkingFetch, createReasoningFetch, createStrategyDiagnosticFetch, toAIMessage } from "./model-provider";
import type { LlmReasoningMode } from "@/lib/llm/types";

describe("DeepSeek thinking request adapter", () => {
  it("logs strategy HTTP timing without request URLs or credentials", async () => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));
      const observed = createStrategyDiagnosticFetch(baseFetch as typeof fetch, "request-1", "test-model");
      await observed("https://provider.example/chat/completions?key=secret-key", {
        headers: { Authorization: "Bearer secret-key" },
      });
      expect(logged).toHaveBeenCalledWith("[execution.strategy] HTTP headers received", expect.objectContaining({
        requestId: "request-1", model: "test-model", httpStatus: 200,
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-key");
    } finally {
      logged.mockRestore();
    }
  });

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

describe("multi-model thinking protocols", () => {
  it.each([
    ["auto-on", "qwen3.8-max", "enable_thinking", true],
    ["auto-off", "qwen3.8-max", "enable_thinking", false],
    ["auto-off", "deepseek-v4-flash", "thinking", { type: "disabled" }],
  ] as const)("adapts %s to %s request parameters", async (mode, model, key, value) => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const adapted = createReasoningFetch(mode, baseFetch as typeof fetch);
    await adapted("https://provider.example/chat/completions", { body: JSON.stringify({ model, messages: [] }) });
    const body = JSON.parse(String(baseFetch.mock.calls[0][1]?.body));
    expect(body[key]).toEqual(value);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it.each([
    ["qwen", { enable_thinking: true }],
    ["qwen-off", { enable_thinking: false }],
    ["thinking", { thinking: { type: "enabled" } }],
    ["thinking-off", { thinking: { type: "disabled" } }],
  ] as const)("sends only the selected %s protocol", async (mode, parameters) => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const adapted = createReasoningFetch(mode, baseFetch as typeof fetch);
    await adapted("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "example", temperature: 0.7, messages: [] }),
    });
    const body = JSON.parse(String(baseFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({ model: "example", messages: [], ...parameters });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toBeUndefined();
  });

  it("keeps the default request unchanged without forcing thinking off", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const adapted = createReasoningFetch("none", baseFetch as typeof fetch);
    const body = '{ "model": "default", "temperature": 0.7, "messages": [] }';
    await adapted("https://provider.example/chat/completions", { method: "POST", body });
    expect(baseFetch.mock.calls[0][1]?.body).toBe(body);
  });

  it.each(["none", "qwen", "thinking"] as LlmReasoningMode[])("preserves assistant reasoning for %s tool continuations", async (mode) => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const adapted = createReasoningFetch(mode, baseFetch as typeof fetch, [
      { role: "assistant", content: "", reasoning_content: "先查资料" } as never,
      { role: "user", content: "工具结果" },
      { role: "assistant", content: "", reasoning_content: "再确认日期" } as never,
    ]);
    await adapted("https://provider.example/chat/completions", {
      body: JSON.stringify({ messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "tool-1" }] },
        { role: "tool", content: "工具结果" },
        { role: "assistant", content: null, tool_calls: [{ id: "tool-2" }] },
      ] }),
    });
    const body = JSON.parse(String(baseFetch.mock.calls[0][1]?.body));
    expect(body.messages[0].reasoning_content).toBe("先查资料");
    expect(body.messages[1].reasoning_content).toBeUndefined();
    expect(body.messages[2].reasoning_content).toBe("再确认日期");
    if (mode === "none") {
      expect(body.thinking).toBeUndefined();
      expect(body.enable_thinking).toBeUndefined();
    }
  });

  it.each(["none", "qwen", "thinking"] as LlmReasoningMode[])("observes streaming reasoning even in %s mode", async (mode) => {
    const baseFetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"分析中"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    }));
    const reasoning: string[] = [];
    const adapted = createReasoningFetch(mode, baseFetch as typeof fetch, [], (text) => reasoning.push(text));
    const response = await adapted("https://provider.example/chat/completions", { body: '{"messages":[]}' });
    expect(await response.text()).toContain("reasoning_content");
    expect(reasoning).toEqual(["分析中"]);
  });
});
