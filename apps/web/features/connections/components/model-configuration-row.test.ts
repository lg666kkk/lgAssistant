import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserLlmModelDraft } from "@/lib/llm/types";
import { ModelConfigurationRow } from "./model-configuration-row";

const model: UserLlmModelDraft = {
  modelId: "example-model",
  displayName: "日常助手",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  temperature: 0.7,
  supportsTools: true,
  supportsImages: false,
  reasoningMode: "none",
  pricing: { inputCacheHit: null, inputCacheMiss: null, output: null },
  enabled: true,
};

function render(expanded = false, patch: Partial<UserLlmModelDraft> = {}, canRemove = true) {
  return renderToStaticMarkup(createElement(ModelConfigurationRow, {
    model: { ...model, ...patch }, expanded, canRemove,
    onToggle: () => {}, onChange: () => {}, onRemove: () => {},
  }));
}

describe("model configuration row", () => {
  it("shows a compact summary without numeric editors or pricing noise", () => {
    const html = render();
    expect(html).toContain("日常助手");
    expect(html).toContain("example-model");
    expect(html).toContain("上下文 128k · 输出 4.1k");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("未配置");
  });

  it("labels fields and explains capabilities, limits and optional pricing", () => {
    const html = render(true);
    for (const label of ["模型 ID", "显示名称", "上下文窗口（Token）", "最大输出（Token）", "允许的能力", "思考模式", "费用估算（可选）"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("获取列表只导入模型 ID");
    expect(html).toContain("这里不是实际账单");
    expect(html).toContain('aria-describedby=');
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*open=/);
  });

  it("offers multiple thinking protocols without a temperature editor", () => {
    const html = render(true);
    for (const mode of ["default", "on", "off", "auto", "deepseek", "qwen", "thinking"]) {
      expect(html).toContain(`value="${mode}"`);
    }
    expect(html).toContain("跟随接口默认行为");
    expect(html).not.toContain("Temperature");
    expect(html).not.toContain("随机性");
    expect(html).not.toContain('step="0.1"');
  });

  it("disables off for always-thinking models and explains unknown automatic adapters", () => {
    expect(render(true, { modelId: "glm-5.3" })).toMatch(/<option value="off" disabled="">/);
    expect(render(true, { reasoningMode: "auto-on" })).toContain("未识别到可靠的思考协议");
    expect(render(true, { modelId: "qwen3.8-max", reasoningMode: "auto-on" })).toContain("自动适配");
  });

  it("preserves zero pricing and prevents deleting the final model", () => {
    const html = render(true, { pricing: { inputCacheHit: 0, inputCacheMiss: null, output: null } }, false);
    expect(html).toMatch(/<input[^>]*step="0.000001"[^>]*value="0"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="删除 日常助手"/);
  });

  it("falls back to the model ID when no display alias is supplied", () => {
    expect(render(false, { displayName: "" })).toContain('aria-label="编辑 example-model"');
  });
});
