import { describe, expect, it } from "vitest";
import { createModelTextFilter, sanitizeModelText } from "./output-sanitizer";

const leakedInvocation = `<｜DSML｜calls><｜DSML｜invoke name="read_tool_artifact"><｜DSML｜parameter name="artifactId" string="true">web_fetch_secret</｜DSML｜parameter><｜DSML｜parameter name="offset" string="false">12000</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>`;

describe("model protocol protection", () => {
  it.each([
    leakedInvocation,
    leakedInvocation.replaceAll("｜", "|"),
    leakedInvocation.replaceAll("｜", " | "),
    `<|DSML|><tool_calls><|DSML|>invoke name="finish_step">report</|DSML|>invoke></tool_calls>`,
  ])("removes the invocation and arguments while preserving preceding prose", (protocol) => {
    expect(sanitizeModelText(`正在查询。\n${protocol}`)).toBe("正在查询。");
  });

  it("never exposes a marker at any two-chunk split and rejects successful completion", () => {
    const text = `正在查询。${leakedInvocation}`;
    for (let split = 0; split <= text.length; split++) {
      const filter = createModelTextFilter();
      const output = filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.finish();
      expect(output).toBe("正在查询。");
      expect(() => filter.assertValid()).toThrow("本次回答未完成");
    }
  });

  it("handles one-character chunks and an incomplete invocation", () => {
    const filter = createModelTextFilter();
    const output = Array.from("查询中< | | DSML | | invoke name=\"read_tool_artifact\"").map((char) => filter.push(char)).join("") + filter.finish();
    expect(output).toBe("查询中");
    expect(() => filter.assertValid()).toThrow();
  });

  it("preserves Markdown, HTML and mathematical comparisons", () => {
    const text = "## 报告\n\n<div>正常正文</div>\n1 < 2，3 > 2\n末尾 <";
    const filter = createModelTextFilter();
    expect(Array.from(text).map((char) => filter.push(char)).join("") + filter.finish()).toBe(text);
    expect(sanitizeModelText(text)).toBe(text);
    expect(() => filter.assertValid()).not.toThrow();
  });
});
