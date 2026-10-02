import { describe, expect, it } from "vitest";
import { LLM_REASONING_MODES } from "./types";
import { detectThinkingProtocol, readThinkingSelection, resolveThinkingMode, supportsThinkingOff, writeThinkingSelection } from "./reasoning";

describe("unified thinking adapter selection", () => {
  it.each(LLM_REASONING_MODES)("preserves existing %s configuration", (mode) => {
    const selection = readThinkingSelection(mode);
    expect(writeThinkingSelection(selection.mode, selection.protocol)).toBe(mode);
  });
  it.each([
    ["qwen3.8-max", "qwen"], ["deepseek-v4-flash", "deepseek"],
    ["deepseek-v3.2", "deepseek"], ["kimi-k3", "thinking"], ["glm-5.3", "thinking"],
    ["openai/gpt-4.1", null], ["custom-model", null], ["deepseek-chat", null],
  ])("detects %s without applying unknown protocols", (model, protocol) => {
    expect(detectThinkingProtocol("https://proxy.example/v1", model!)).toBe(protocol);
  });
  it("prioritizes the gateway protocol over the model family", () => {
    expect(resolveThinkingMode("auto-on", "https://dashscope.aliyuncs.com/compatible-mode/v1", "deepseek-v4-flash")).toBe("qwen");
    expect(detectThinkingProtocol("https://dashscope.aliyuncs.com/v1", "custom-model")).toBeNull();
  });
  it("keeps unknown models at provider defaults and allows explicit overrides", () => {
    expect(resolveThinkingMode("auto-on", "https://unknown.example", "custom-model")).toBe("none");
    expect(resolveThinkingMode("auto-off", "https://unknown.example", "custom-model")).toBe("none");
    expect(resolveThinkingMode("qwen", "https://unknown.example", "custom-model")).toBe("qwen");
  });
  it("selects the appropriate off parameter without changing default behavior", () => {
    expect(resolveThinkingMode("auto-off", "", "qwen3.8-max")).toBe("qwen-off");
    expect(resolveThinkingMode("auto-off", "", "deepseek-v4-flash")).toBe("deepseek-off");
    expect(resolveThinkingMode("none", "", "glm-5.3")).toBe("none");
  });
  it("blocks turning off models known to require thinking", () => {
    expect(supportsThinkingOff("zai/glm-5.3-flash")).toBe(false);
    expect(supportsThinkingOff("glm-4.7")).toBe(true);
    expect(() => resolveThinkingMode("auto-off", "", "glm-5.3")).toThrow("不支持关闭思考");
    expect(() => resolveThinkingMode("thinking-off", "", "glm-5.3")).toThrow("不支持关闭思考");
  });
});
