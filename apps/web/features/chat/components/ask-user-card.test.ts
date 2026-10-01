import { describe, expect, it } from "vitest";
import { readUserQuestions, formatUserAnswers } from "./ask-user-card";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskUserCard } from "./ask-user-card";
describe("question cards", () => {
  it("supports old single-question records and new question batches", () => {
    expect(readUserQuestions({ question: "位置？", choices: ["北京", 42] })).toEqual([{ question: "位置？", choices: ["北京"] }]);
    expect(readUserQuestions({ questions: [{ question: "位置？" }, { question: "范围？", choices: ["附近"] }] })).toHaveLength(2);
  });
  it("submits both custom and selected answers with their corresponding questions", () => {
    expect(formatUserAnswers([{ question: "位置？" }, { question: "范围？" }], [" 望京 ", "附近"])).toBe("1. 位置？\n回答：望京\n\n2. 范围？\n回答：附近");
  });
  it("shows a submit action without pagination for a single unanswered question", () => {
    const html = renderToStaticMarkup(createElement(AskUserCard, {
      questions: [{ question: "你想查哪个城市的天气？" }],
      onSubmit: async () => {},
    }));
    expect(html).toContain("提交并继续");
    expect(html).not.toContain("下一题");
    expect(html).not.toContain("上一题");
    expect(html).not.toContain("1 / 1");
  });
  it("retains navigation and answer progress for multiple questions", () => {
    const html = renderToStaticMarkup(createElement(AskUserCard, {
      questions: [{ question: "位置？" }, { question: "范围？" }],
      disabled: true,
      onSubmit: async () => {},
    }));
    expect(html).toContain('aria-label="问题切换"');
    expect(html).toContain("已回答 0 / 2");
    expect(html).toMatch(/aria-label="下一题" disabled=""/);
  });
});
