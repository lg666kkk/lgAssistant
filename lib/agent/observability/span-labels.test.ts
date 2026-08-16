import { describe, expect, it } from "vitest";
import {
  SPAN_LABELS,
  SPAN_LABEL_METADATA_KEY,
  UNKNOWN_SPAN_LABEL,
  resolveSpanLabel,
  toSharedTraceMetadata,
  withSpanLabel,
} from "./span-labels";

describe("resolveSpanLabel", () => {
  it("精确命中已登记的 span 名", () => {
    expect(resolveSpanLabel("memory.recall")).toBe(SPAN_LABELS["memory.recall"]);
    expect(resolveSpanLabel("memory.rerank")).toBe(SPAN_LABELS["memory.rerank"]);
    expect(resolveSpanLabel("retrieval.route")).toBe(SPAN_LABELS["retrieval.route"]);
  });

  it("带工具后缀的动态 functionId 回退到前缀标签", () => {
    expect(resolveSpanLabel("agent-loop-after-tools:search_notes+read_tool_artifact"))
      .toBe(SPAN_LABELS["agent-loop-after-tools"]);
    expect(resolveSpanLabel("retrieval.web:web_search"))
      .toBe(SPAN_LABELS["retrieval.web"]);
    expect(resolveSpanLabel("retrieval.knowledge:search_notes"))
      .toBe(SPAN_LABELS["retrieval.knowledge"]);
  });

  it("优先取最长匹配而不是最短前缀", () => {
    expect(resolveSpanLabel("plan-and-execute-planner:repair"))
      .toBe(SPAN_LABELS["plan-and-execute-planner:repair"]);
    expect(resolveSpanLabel("plan-and-execute-planner:ai-sdk"))
      .toBe(SPAN_LABELS["plan-and-execute-planner"]);
  });

  it("未登记或空名字返回兜底文案", () => {
    expect(resolveSpanLabel("something.unknown")).toBe(UNKNOWN_SPAN_LABEL);
    expect(resolveSpanLabel("")).toBe(UNKNOWN_SPAN_LABEL);
  });

  it("所有登记的标签都是中文说明", () => {
    for (const [name, label] of Object.entries(SPAN_LABELS)) {
      expect(label, name).toMatch(/[一-龥]/);
    }
  });
});

describe("withSpanLabel", () => {
  it("在保留原 metadata 的同时补上中文标识", () => {
    expect(withSpanLabel("memory.consolidate", { requestId: "req-1" })).toEqual({
      requestId: "req-1",
      [SPAN_LABEL_METADATA_KEY]: SPAN_LABELS["memory.consolidate"],
    });
  });

  it("没有 metadata 时也能产出标识字段", () => {
    expect(withSpanLabel("context.compaction")).toEqual({
      [SPAN_LABEL_METADATA_KEY]: SPAN_LABELS["context.compaction"],
    });
  });

  it("调用方显式给了 spanLabel 时不覆盖", () => {
    expect(withSpanLabel("memory.recall", { [SPAN_LABEL_METADATA_KEY]: "自定义说明" }))
      .toEqual({ [SPAN_LABEL_METADATA_KEY]: "自定义说明" });
  });
});

describe("toSharedTraceMetadata", () => {
  it("不把根 observation 的 spanLabel 传播给子 span", () => {
    expect(toSharedTraceMetadata({
      requestId: "req-1",
      model: "deepseek-v4-pro",
      [SPAN_LABEL_METADATA_KEY]: SPAN_LABELS["agent-chat"],
    })).toEqual({
      requestId: "req-1",
      model: "deepseek-v4-pro",
    });
  });
});
