import { describe, expect, it } from "vitest";
import {
  createFallbackPlan,
  normalizeExecutionPlan,
  normalizePlanExecutionControl,
  parsePlan,
  parsePlanWithDiagnostics,
  shouldUsePlanAndExecute,
} from "./plan-execution";

describe("Plan-and-Execute contract", () => {
  it("只对多步骤任务启用规划", () => {
    expect(shouldUsePlanAndExecute("现在几点" )).toBe(false);
    expect(shouldUsePlanAndExecute("请检索本周会议记录，然后整理待办并安排下周提醒" )).toBe(true);
  });

  it("解析规划时丢弃不存在的工具并保留可验证步骤", () => {
    const plan = parsePlan(`\n\`\`\`json
      {"id":"plan-1","objective":"准备会议","steps":[
        {"id":"find","goal":"检索会议记录","allowedTools":["search_notes","unknown"],"successCriteria":["找到相关记录"]},
        {"id":"todo","goal":"创建待办","allowedTools":["create_todo"],"successCriteria":["待办已创建"]}
      ]}
    \`\`\``, new Set(["search_notes", "create_todo"]));

    expect(plan).toEqual({
      id: "plan-1",
      objective: "准备会议",
      steps: [
        {
          id: "find",
          goal: "检索会议记录",
          allowedTools: ["search_notes"],
          successCriteria: ["找到相关记录"],
        },
        {
          id: "todo",
          goal: "创建待办",
          allowedTools: ["create_todo"],
          successCriteria: ["待办已创建"],
        },
      ],
    });
  });

  it("接受 JSON 前后带解释的模型输出", () => {
    const plan = parsePlan(`我建议按以下计划执行：
      {"objective":"准备会议","steps":[
        {"goal":"检索记录","allowedTools":["search_notes"],"successCriteria":["找到记录"]},
        {"goal":"创建待办","allowedTools":["create_todo"],"successCriteria":["待办已创建"]}
      ]}
      以上是计划。`, new Set(["search_notes", "create_todo"]));

    expect(plan?.objective).toBe("准备会议");
    expect(plan?.steps).toHaveLength(2);
  });

  it("拒绝无法形成执行计划的输出", () => {
    expect(parsePlan("not json", new Set())).toBeNull();
    expect(parsePlan('{"steps":[{"goal":"只有一步"}]}', new Set())).toBeNull();
  });

  it("为无法解析的计划输出返回诊断原因", () => {
    expect(parsePlanWithDiagnostics("not json", new Set())).toEqual({
      plan: null,
      reason: "no_json_object",
    });
    expect(parsePlanWithDiagnostics('{"steps":[{"goal":"只有一步"}]}', new Set())).toEqual({
      plan: null,
      reason: "invalid_plan_shape",
    });
  });

  it("确认前重新校验用户编辑过的计划", () => {
    const plan = normalizeExecutionPlan({
      id: "edited-plan",
      objective: "完成任务",
      steps: [
        { id: "one", goal: "检索资料", allowedTools: ["search_notes", "shell"], successCriteria: ["有资料"] },
        { id: "two", goal: "整理结果", allowedTools: [], successCriteria: ["有总结"] },
      ],
    }, new Set(["search_notes"]));

    expect(plan?.steps[0].allowedTools).toEqual(["search_notes"]);
    expect(normalizeExecutionPlan({ steps: [{ goal: "只有一步" }] }, new Set())).toBeNull();
  });

  it("只接受计划内步骤的恢复控制", () => {
    const plan = normalizeExecutionPlan({
      id: "resume-plan",
      steps: [
        { id: "one", goal: "第一步" },
        { id: "two", goal: "第二步" },
      ],
    }, new Set());
    expect(plan).not.toBeNull();

    const control = normalizePlanExecutionControl({
      startAtStep: 1,
      skipStepIds: ["two", "unknown"],
      priorStepResults: [
        { stepId: "one", status: "completed", resultSummary: "第一步完成" },
        { stepId: "unknown", status: "completed", resultSummary: "伪造" },
      ],
    }, plan!);

    expect(control).toEqual({
      startAtStep: 1,
      skipStepIds: ["two"],
      priorStepResults: [
        { stepId: "one", status: "completed", resultSummary: "第一步完成" },
      ],
    });
  });

  it("在模型规划不可用时提供可编辑的保守模板计划", () => {
    const plan = createFallbackPlan("比较资料后给出投资分析", new Set(["web_search", "ask_user"]));

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].allowedTools).toEqual(["web_search"]);
    expect(plan.steps[1].allowedTools).toEqual([]);
    expect(plan.steps[2].allowedTools).toEqual(["ask_user"]);
  });
});
