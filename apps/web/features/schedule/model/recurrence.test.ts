import { describe, expect, it } from "vitest";
import { CronExpressionParser } from "cron-parser";
import { defaultRecurrence, describeCron, describeRecurrence, recurrenceFromCron, recurrenceToCron } from "./recurrence";

describe("recurring schedule form", () => {
  it("defaults to daily at 09:00", () => {
    expect(recurrenceToCron(defaultRecurrence())).toBe("0 9 * * *");
    expect(describeRecurrence(defaultRecurrence(), "Asia/Shanghai")).toBe("每天，北京时间（中国） 09:00 执行");
  });

  it.each([
    ["0 9 * * *", "daily", "09:00", "0 9 * * *"],
    ["  05 08 * * *  ", "daily", "08:05", "5 8 * * *"],
    ["30 18 * * 1-5", "weekdays", "18:30", "30 18 * * 1-5"],
    ["0 9 * * 5,4,3,2,1", "weekdays", "09:00", "0 9 * * 1-5"],
    ["0 0 * * 0", "weekly", "00:00", "0 0 * * 0"],
    ["15 8 * * 7", "weekly", "08:15", "15 8 * * 0"],
    ["15 8 * * 0,7,1,1", "weekly", "08:15", "15 8 * * 1,0"],
    ["45 21 * * 1,3,5", "weekly", "21:45", "45 21 * * 1,3,5"],
    ["59 23 31 * *", "monthly", "23:59", "59 23 31 * *"],
  ])("decodes %s without changing execution times", (cron, frequency, time, normalized) => {
    const recurrence = recurrenceFromCron(cron);
    expect(recurrence).toMatchObject({ frequency, time });
    expect(recurrenceToCron(recurrence)).toBe(normalized);
    const options = { currentDate: "2026-09-05T00:00:00Z", tz: "Asia/Shanghai" };
    const before = CronExpressionParser.parse(cron, options);
    const after = CronExpressionParser.parse(normalized, options);
    for (let index = 0; index < 10; index += 1) {
      expect(after.next().toISOString()).toBe(before.next().toISOString());
    }
  });

  it.each([
    "*/15 * * * *", "0 9,18 * * *", "0 9 1 * 1", "0 9 * 1 *",
    "0 9 * * MON-FRI", "0 0 9 * * *", "@daily", "0 9 L * *",
    "  */5 * * * *  ", "60 9 * * *", "0 24 * * *", "0 9 32 * *",
    "0 9 0 * *", "0 9 * * 8", "not a cron", "",
  ])("keeps unsupported or invalid expressions verbatim: %s", (cron) => {
    const recurrence = recurrenceFromCron(cron);
    expect(recurrence.frequency).toBe("custom");
    expect(recurrence.customCron).toBe(cron);
    if (cron) expect(recurrenceToCron(recurrence)).toBe(cron);
  });

  it("supports every basic frequency and sorts selected days", () => {
    const base = { ...defaultRecurrence(), time: "07:05" };
    expect(recurrenceToCron({ ...base, frequency: "weekdays" })).toBe("5 7 * * 1-5");
    expect(recurrenceToCron({ ...base, frequency: "weekly", weekdays: [5, 1, 3, 1] })).toBe("5 7 * * 1,3,5");
    expect(recurrenceToCron({ ...base, frequency: "monthly", monthDay: 15 })).toBe("5 7 15 * *");
  });

  it.each(["", "9:00", "24:00", "12:60", "09:00:30"])("rejects invalid basic time %s", (time) => {
    expect(() => recurrenceToCron({ ...defaultRecurrence(), time })).toThrow("请选择有效的执行时间");
  });

  it("requires a weekday and valid monthly date before submitting", () => {
    expect(() => recurrenceToCron({ ...defaultRecurrence(), frequency: "weekly", weekdays: [] })).toThrow("请至少选择一天");
    for (const weekdays of [[7], [-1], [1.5]]) {
      expect(() => recurrenceToCron({ ...defaultRecurrence(), frequency: "weekly", weekdays })).toThrow("请选择有效的星期");
    }
    for (const monthDay of [0, 32, 1.5, Number.NaN]) {
      expect(() => recurrenceToCron({ ...defaultRecurrence(), frequency: "monthly", monthDay })).toThrow("1 至 31");
    }
    expect(() => recurrenceToCron({ ...defaultRecurrence(), frequency: "custom", customCron: " " })).toThrow("请填写");
  });

  it("explains weekly, holiday and short-month behavior", () => {
    expect(describeCron("0 9 * * 1,3,5", "Asia/Shanghai")).toContain("每周一、周三、周五");
    expect(describeCron("0 9 * * 1-5", "Asia/Shanghai")).toContain("不自动跳过法定节假日");
    expect(describeCron("0 9 29 * *", "UTC")).toContain("没有该日期的月份跳过");
    expect(describeCron("0 9 28 * *", "UTC")).not.toContain("跳过");
    expect(describeCron("*/5 * * * *", "Europe/Paris")).toBe("自定义规则：*/5 * * * * · Europe/Paris");
    expect(describeRecurrence({ ...defaultRecurrence(), frequency: "weekly", weekdays: [] }, "UTC")).toBe("请至少选择一天");
  });

  it("skips months without the selected date", () => {
    const cron = recurrenceToCron({ ...defaultRecurrence(), frequency: "monthly", monthDay: 31 });
    const expression = CronExpressionParser.parse(cron, { currentDate: "2026-04-01T00:00:00Z", tz: "Asia/Shanghai" });
    expect(expression.next().toISOString()).toBe("2026-05-31T01:00:00.000Z");
  });

  it("uses wall-clock time in the chosen zone, including daylight saving changes", () => {
    const cron = recurrenceToCron(defaultRecurrence());
    const expression = CronExpressionParser.parse(cron, { currentDate: "2026-10-31T00:00:00Z", tz: "America/New_York" });
    expect(expression.next().toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(expression.next().toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
});
