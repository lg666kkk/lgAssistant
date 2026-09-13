import { describe, expect, it } from "vitest";
import { askUserTool } from "./ask-user";

describe("ask_user tool", () => {
  it("returns an awaiting-user-input result", async () => {
    const result = await askUserTool.execute({
      question: "你偏好哪种风险等级？",
      mode: "single_choice",
      choices: ["保守", "均衡", "进取"],
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      status: "awaiting_user_input",
      question: "你偏好哪种风险等级？",
      mode: "single_choice",
      choices: ["保守", "均衡", "进取"],
    });
  });

  it("rejects an empty question", async () => {
    await expect(askUserTool.execute({ question: " " })).rejects.toThrow("question");
  });

  it("requires choices for a single-choice question", async () => {
    await expect(
      askUserTool.execute({ question: "请选择", mode: "single_choice" }),
    ).rejects.toThrow("choices");
  });
});

describe("ask_user question batches", () => {
  it("preserves multiple questions and infers choice mode", async () => {
    const result = await askUserTool.execute({ questions: [{ question: "工作范围？", choices: ["当前文件", "整个项目"] }, { question: "还有其他要求吗？" }] });
    expect(result.metadata?.questions).toMatchObject([{ question: "工作范围？", mode: "single_choice" }, { question: "还有其他要求吗？", mode: "free_text" }]);
    expect(result.metadata?.question).toContain("2. 还有其他要求吗？");
  });
  it("rejects empty or oversized batches", async () => {
    await expect(askUserTool.execute({ questions: [] })).rejects.toThrow("1 到 3");
    await expect(askUserTool.execute({ questions: Array(4).fill({ question: "test" }) })).rejects.toThrow("1 到 3");
  });
});
