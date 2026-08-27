import { describe, expect, it } from "vitest";
import { sanitizeModelText } from "./output-sanitizer";

describe("sanitizeModelText", () => {
  it("removes DeepSeek DSML tool protocol while preserving report text", () => {
    const text = `<|DSML|><tool_calls><|DSML|>invoke name="finish_step"><|DSML|>parameter name="step_result" string="true">已完成</|DSML|>parameter><|DSML|>parameter name="report" string="true">\n报告正文\n</|DSML|>parameter></|DSML|>invoke></|DSML|></tool_calls>`;

    expect(sanitizeModelText(text)).toBe("已完成\n报告正文\n");
  });

  it("removes full-width DeepSeek DSML protocol markers", () => {
    const text = `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜\n<｜｜DSML｜｜zh-CN</｜｜DSML｜｜\n<｜｜DSML｜｜Asia/Shanghai</｜｜DSML｜｜\n</｜｜DSML｜｜\n</｜｜DSML｜｜tool_calls>`;

    expect(sanitizeModelText(text).trim()).toBe("zh-CN\nAsia/Shanghai");
  });

  it("removes full-width DSML parameter wrappers", () => {
    const text = `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜parameter name="limit" string="false">5</｜｜DSML｜｜\n<｜｜DSML｜｜黄金价格 最新趋势</｜｜DSML｜｜\n</｜｜DSML｜｜tool_calls>`;

    expect(sanitizeModelText(text).trim()).toBe("parameter name=\"limit\" string=\"false\">5\n黄金价格 最新趋势");
  });

  it("keeps normal Markdown unchanged", () => {
    expect(sanitizeModelText("## 报告\n\n正常正文")).toBe("## 报告\n\n正常正文");
  });
});
