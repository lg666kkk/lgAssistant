import { describe, expect, it } from "vitest";
import { readUserQuestions, formatUserAnswers } from "./ask-user-card";
describe("question cards", () => {
  it("supports old single-question records and new question batches", () => {
    expect(readUserQuestions({ question: "位置？", choices: ["北京", 42] })).toEqual([{ question: "位置？", choices: ["北京"] }]);
    expect(readUserQuestions({ questions: [{ question: "位置？" }, { question: "范围？", choices: ["附近"] }] })).toHaveLength(2);
  });
  it("submits both custom and selected answers with their corresponding questions", () => {
    expect(formatUserAnswers([{ question: "位置？" }, { question: "范围？" }], [" 望京 ", "附近"])).toBe("1. 位置？\n回答：望京\n\n2. 范围？\n回答：附近");
  });
});
