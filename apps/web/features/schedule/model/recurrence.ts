export type RecurrenceFrequency = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export type Recurrence = {
  frequency: RecurrenceFrequency;
  time: string;
  weekdays: number[];
  monthDay: number;
  customCron: string;
};

export const WEEKDAYS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

export const TIMEZONES = [
  { value: "Asia/Shanghai", label: "北京时间（中国）" },
  { value: "Asia/Hong_Kong", label: "香港时间" },
  { value: "Asia/Tokyo", label: "东京时间（日本）" },
  { value: "Asia/Singapore", label: "新加坡时间" },
  { value: "America/New_York", label: "纽约时间（美国东部）" },
  { value: "America/Los_Angeles", label: "洛杉矶时间（美国西部）" },
  { value: "Europe/London", label: "伦敦时间（英国）" },
  { value: "UTC", label: "协调世界时（UTC）" },
];

export function defaultRecurrence(): Recurrence {
  return { frequency: "daily", time: "09:00", weekdays: [1], monthDay: 1, customCron: "0 9 * * *" };
}

export function recurrenceFromCron(cron: string): Recurrence {
  const fallback: Recurrence = { ...defaultRecurrence(), frequency: "custom", customCron: cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minute, hour, monthDay, month, weekdays] = fields;
  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59 ||
      !/^\d{1,2}$/.test(hour) || Number(hour) > 23 || month !== "*") return fallback;
  const base = { ...fallback, time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` };
  if (monthDay === "*" && weekdays === "*") return { ...base, frequency: "daily" };
  if (weekdays === "*" && /^\d{1,2}$/.test(monthDay) && Number(monthDay) >= 1 && Number(monthDay) <= 31) {
    return { ...base, frequency: "monthly", monthDay: Number(monthDay) };
  }
  if (monthDay !== "*") return fallback;
  if (weekdays === "1-5") return { ...base, frequency: "weekdays", weekdays: [1, 2, 3, 4, 5] };
  if (!/^[0-7](,[0-7])*$/.test(weekdays)) return fallback;
  const selectedDays = Array.from(new Set(weekdays.split(",").map((day) => Number(day) % 7)));
  const isWeekdays = selectedDays.length === 5 && [1, 2, 3, 4, 5].every((day) => selectedDays.includes(day));
  return { ...base, frequency: isWeekdays ? "weekdays" : "weekly", weekdays: selectedDays };
}

export function recurrenceToCron(recurrence: Recurrence): string {
  if (recurrence.frequency === "custom") {
    if (!recurrence.customCron.trim()) throw new Error("请填写自定义 Cron 表达式");
    return recurrence.customCron;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(recurrence.time)) throw new Error("请选择有效的执行时间");
  const [hour, minute] = recurrence.time.split(":").map(Number);
  const prefix = `${minute} ${hour}`;
  switch (recurrence.frequency) {
    case "daily":
      return `${prefix} * * *`;
    case "weekdays":
      return `${prefix} * * 1-5`;
    case "weekly": {
      if (!recurrence.weekdays.length) throw new Error("请至少选择一天");
      if (recurrence.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error("请选择有效的星期");
      }
      const days = WEEKDAYS.filter((day) => recurrence.weekdays.includes(day.value)).map((day) => day.value);
      return `${prefix} * * ${days.join(",")}`;
    }
    case "monthly":
      if (!Number.isInteger(recurrence.monthDay) || recurrence.monthDay < 1 || recurrence.monthDay > 31) {
        throw new Error("每月执行日期必须在 1 至 31 日之间");
      }
      return `${prefix} ${recurrence.monthDay} * *`;
  }
}

export function describeRecurrence(recurrence: Recurrence, timezone: string): string {
  const zone = TIMEZONES.find((item) => item.value === timezone)?.label ?? timezone;
  if (recurrence.frequency === "custom") return `自定义规则：${recurrence.customCron || "未填写"} · ${zone}`;
  try {
    recurrenceToCron(recurrence);
  } catch (error) {
    return error instanceof Error ? error.message : "请完善周期设置";
  }
  const frequency = {
    daily: "每天",
    weekdays: "每周一至周五（不自动跳过法定节假日）",
    weekly: `每${WEEKDAYS.filter((day) => recurrence.weekdays.includes(day.value)).map((day) => day.label).join("、")}`,
    monthly: `每月 ${recurrence.monthDay} 日`,
  }[recurrence.frequency];
  return `${frequency}，${zone} ${recurrence.time} 执行${recurrence.frequency === "monthly" && recurrence.monthDay > 28 ? "；没有该日期的月份跳过" : ""}`;
}

export function describeCron(cron: string, timezone: string): string {
  return describeRecurrence(recurrenceFromCron(cron), timezone);
}
