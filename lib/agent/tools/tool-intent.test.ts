import { describe, expect, it } from "vitest";
import {
  filterToolsForUserIntent,
  isExplicitCreateTodoRequest,
  isLongTermMemoryStatement,
} from "./tool-intent";

describe("create_todo 可见性门控", () => {
  it("只接受明确创建或加入待办的表达", () => {
    expect(isExplicitCreateTodoRequest("帮我创建一个买菜待办")).toBe(true);
    expect(isExplicitCreateTodoRequest("把周报加入待办列表")).toBe(true);
    expect(isExplicitCreateTodoRequest("新增 TODO：周五提交报告")).toBe(true);
    expect(isExplicitCreateTodoRequest("提醒一下，我对香菜过敏")).toBe(false);
    expect(isExplicitCreateTodoRequest("记住我喜欢简洁回答")).toBe(false);
    expect(isExplicitCreateTodoRequest("明天下午提醒我开会")).toBe(false);
  });

  it("非明确待办请求不向模型暴露 create_todo", () => {
    const tools = [
      { name: "create_todo", description: "todo", input_schema: {} },
      { name: "ask_user", description: "ask", input_schema: {} },
      { name: "calculator", description: "calc", input_schema: {} },
    ];
    expect(filterToolsForUserIntent(tools, "提醒一下我的偏好").map((tool) => tool.name))
      .toEqual(["calculator"]);
    expect(filterToolsForUserIntent(tools, "创建一个待办").map((tool) => tool.name))
      .toEqual(["create_todo", "ask_user", "calculator"]);
  });

  it("长期偏好陈述不暴露待办和追问工具", () => {
    expect(isLongTermMemoryStatement("提醒一下，我对香菜过敏，以后推荐菜不要带香菜"))
      .toBe(true);
    expect(isLongTermMemoryStatement("我喜欢简洁的代码风格")).toBe(true);
    expect(isLongTermMemoryStatement("帮我分析这段代码")).toBe(false);
  });
});
