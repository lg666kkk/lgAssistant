import { describe, expect, it } from "vitest";
import { readScheduledJobDraft } from "./scheduled-job-card";
describe("scheduled task confirmation summary", () => {
  it("shows local time, task and output defaults", () => {
    const draft = readScheduledJobDraft({ type: "reminder", runAt: "2030-01-01T09:00:00+08:00", payload: { text: "喝水" } });
    expect(draft).toMatchObject({ content: "喝水", timezone: "Asia/Shanghai", outputs: "站内任务结果" });
    expect(draft?.time).toContain("09:00");
  });
  it("handles missing parameters and invalid dates without crashing", () => {
    expect(readScheduledJobDraft(null)).toBeNull();
    expect(readScheduledJobDraft({ runAt: "invalid" })?.time).toContain("无效");
  });
});
