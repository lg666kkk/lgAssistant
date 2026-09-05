"use client";

import { useState } from "react";
import {
  describeRecurrence,
  recurrenceFromCron,
  recurrenceToCron,
  TIMEZONES,
  WEEKDAYS,
  type Recurrence,
  type RecurrenceFrequency,
} from "../model/recurrence";

const INPUT_CLASS = "w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600";

export function RecurrenceFields({ value, timezone, onChange, onTimezoneChange }: {
  value: Recurrence;
  timezone: string;
  onChange: (value: Recurrence) => void;
  onTimezoneChange: (timezone: string) => void;
}) {
  const [customTimezone, setCustomTimezone] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const isCustomTimezone = customTimezone || !TIMEZONES.some((item) => item.value === timezone);
  const changeFrequency = (frequency: RecurrenceFrequency) => {
    setSwitchError(null);
    if (frequency === "custom") {
      try {
        onChange({ ...value, frequency, customCron: recurrenceToCron(value) });
      } catch (error) {
        setSwitchError(error instanceof Error ? error.message : "请完善周期设置");
      }
      return;
    }
    const base = value.frequency === "custom" ? recurrenceFromCron(value.customCron) : value;
    onChange({ ...base, frequency });
  };

  return (
    <div className="grid gap-4 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">重复频率</span>
          <select value={value.frequency} onChange={(event) => changeFrequency(event.target.value as RecurrenceFrequency)} className={INPUT_CLASS}>
            <option value="daily">每天</option>
            <option value="weekdays">每周一至周五</option>
            <option value="weekly">每周（选择星期）</option>
            <option value="monthly">每月</option>
            <option value="custom">自定义 Cron（高级）</option>
          </select>
        </label>
        {value.frequency !== "custom" && (
          <label className="grid gap-1.5">
            <span className="text-sm text-slate-400">执行时间（24 小时制）</span>
            <input type="time" step={60} value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} className={INPUT_CLASS} />
          </label>
        )}
      </div>
      {switchError && <p role="alert" className="text-sm text-amber-400">{switchError}</p>}
      {value.frequency === "weekly" && (
        <fieldset className="grid gap-2">
          <legend className="text-sm text-slate-400">每周哪几天</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <label key={day.value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${value.weekdays.includes(day.value) ? "border-cyan-700 bg-cyan-950/40 text-cyan-200" : "border-slate-700 text-slate-400"}`}>
                <input type="checkbox" checked={value.weekdays.includes(day.value)} onChange={(event) => onChange({ ...value, weekdays: event.target.checked ? [...value.weekdays, day.value] : value.weekdays.filter((selected) => selected !== day.value) })} className="accent-cyan-500" />
                {day.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {value.frequency === "monthly" && (
        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">每月几号</span>
          <select value={value.monthDay} onChange={(event) => onChange({ ...value, monthDay: Number(event.target.value) })} className={INPUT_CLASS}>
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day} 日</option>)}
          </select>
        </label>
      )}
      {value.frequency === "custom" && (
        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">Cron 表达式</span>
          <input value={value.customCron} onChange={(event) => onChange({ ...value, customCron: event.target.value })} placeholder="0 9 * * *" className={`${INPUT_CLASS} font-mono`} aria-describedby="cron-help" />
          <span id="cron-help" className="text-xs leading-5 text-slate-500">格式：分 时 日 月 星期。例如 0 9 * * * 表示每天 09:00。切换到普通频率会替换当前自定义规则。</span>
        </label>
      )}
      <label className="grid gap-1.5">
        <span className="text-sm text-slate-400">按哪个时区执行</span>
        <select value={isCustomTimezone ? "custom" : timezone} onChange={(event) => {
          setCustomTimezone(event.target.value === "custom");
          if (event.target.value !== "custom") onTimezoneChange(event.target.value);
        }} className={INPUT_CLASS}>
          {TIMEZONES.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
          <option value="custom">其他时区（手动填写）</option>
        </select>
      </label>
      {isCustomTimezone && (
        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">时区标识（IANA）</span>
          <input value={timezone} onChange={(event) => onTimezoneChange(event.target.value)} placeholder="例如 Europe/Paris" className={INPUT_CLASS} />
        </label>
      )}
      <p role="status" className="rounded-md bg-cyan-950/30 px-3 py-2 text-sm leading-6 text-cyan-200">
        {describeRecurrence(value, timezone)}
      </p>
    </div>
  );
}
