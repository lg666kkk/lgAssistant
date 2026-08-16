import { describe, expect, it } from "vitest";
import { appendToolResults } from "./index";

describe("DeepSeek reasoning continuation", () => {
  it("keeps reasoning_content on an assistant tool-call message", () => {
    const messages = appendToolResults(
      [{ role: "user", content: "查询天气" }],
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "weather-1", name: "weather", input: {} }],
        reasoning_content: "需要调用天气工具。",
      } as never,
      [{
        type: "tool_result",
        tool_use_id: "weather-1",
        content: "晴",
        is_error: false,
      }],
    );

    expect(messages[1]).toEqual(expect.objectContaining({
      role: "assistant",
      reasoning_content: "需要调用天气工具。",
    }));
  });
});
