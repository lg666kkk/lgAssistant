// Agent 行为测试集：给定输入消息，期望 Agent 表现出某些客观行为。
export type EvalCase = {
  id: string;
  description: string;
  messages: { role: "user" | "assistant"; content: string }[];
  expect: {
    shouldCallTool?: string;   // 期望 trace.steps 里出现某个工具
    shouldComplete?: boolean;  // 期望 stopReason === "completed"
    maxModelCalls?: number;    // 期望模型调用次数不超过 N（防止绕圈）
    mustNotError?: boolean;    // 期望没有 ok=false 的 tool step
  };
};

export const evalCases: EvalCase[] = [
  {
    id: "time-tool",
    description: "问时间应触发 get_current_time",
    messages: [{ role: "user", content: "现在几点？用上海时区" }],
    expect: { shouldCallTool: "get_current_time", shouldComplete: true, mustNotError: true },
  },
  {
    id: "calc-tool",
    description: "算术应触发 calculator",
    messages: [{ role: "user", content: "帮我算 123 * 456 等于多少" }],
    expect: { shouldCallTool: "calculator", shouldComplete: true, mustNotError: true },
  },
  {
    id: "plain-chat",
    description: "纯闲聊不调工具且应一轮完成",
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
    expect: { shouldComplete: true, maxModelCalls: 2 },
  },
];
