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
