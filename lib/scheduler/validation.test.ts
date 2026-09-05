import { describe, expect, it } from "vitest";
import { normalizeScheduledJobPayload } from "./validation";

describe("scheduled job payload validation", () => {
  it("normalizes supported notification channels", () => {
    expect(normalizeScheduledJobPayload("agent-task", {
      prompt: "生成日报",
      channels: ["telegram", "telegram", "wecom"],
    })).toEqual({
      prompt: "生成日报",
      channels: ["inapp", "telegram", "wecom"],
    });
  });

  it("rejects unknown notification channels", () => {
    expect(() => normalizeScheduledJobPayload("reminder", {
      text: "开会",
      channels: ["webhook"],
    })).toThrow("输出方式只支持");
  });

  it("requires agent content", () => {
    expect(() => normalizeScheduledJobPayload("agent-task", { channels: [] }))
      .toThrow("必须填写执行内容");
  });

  it("defaults every task to an in-app preview", () => {
    expect(normalizeScheduledJobPayload("reminder", { text: "开会" }).channels)
      .toEqual(["inapp"]);
  });

  it("validates the optional task name", () => {
    expect(() => normalizeScheduledJobPayload("reminder", {
      name: 123,
      text: "开会",
    })).toThrow("任务名称必须是字符串");
  });

  it("validates the optional model id", () => {
    expect(() => normalizeScheduledJobPayload("agent-task", {
      prompt: "生成日报",
      modelId: 123,
    })).toThrow("任务模型 ID 必须是字符串");
  });
});
