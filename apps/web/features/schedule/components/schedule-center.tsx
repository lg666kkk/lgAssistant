"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@web/lib/auth/client";

type ScheduledJob = {
  id: string;
  userId: string;
  type: "reminder" | "leetcode-daily" | "agent-task";
  cron: string | null;
  runAt: number | null;
  nextRunAt: number;
  timezone: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  lastResult: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type FormState = {
  type: ScheduledJob["type"];
  mode: "runAt" | "cron";
  runAt: string;
  cron: string;
  timezone: string;
  payloadText: string;
  enabled: boolean;
};

const TYPE_LABEL: Record<ScheduledJob["type"], string> = {
  reminder: "提醒",
  "leetcode-daily": "LeetCode",
  "agent-task": "Agent",
};

function formatDateTime(value?: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function toLocalInputValue(value?: number | null) {
  if (!value) return "";
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromLocalInputValue(value: string) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function payloadPreview(payload: Record<string, unknown>) {
  const text = typeof payload.text === "string" ? payload.text : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  return (text || prompt || JSON.stringify(payload)).slice(0, 80);
}

function toForm(job: ScheduledJob): FormState {
  return {
    type: job.type,
    mode: job.cron ? "cron" : "runAt",
    runAt: toLocalInputValue(job.runAt),
    cron: job.cron ?? "",
    timezone: job.timezone || "Asia/Shanghai",
    payloadText: JSON.stringify(job.payload ?? {}, null, 2),
    enabled: job.enabled,
  };
}

function statusClass(job: ScheduledJob) {
  if (!job.enabled) return "border-slate-700 bg-slate-900 text-slate-400";
  if (job.lastError) return "border-rose-900 bg-rose-950/50 text-rose-300";
  return "border-emerald-900 bg-emerald-950/50 text-emerald-300";
}

function jobStatusText(job: ScheduledJob) {
  if (!job.enabled) return "已停用";
  if (job.lastError) return "失败";
  return "运行中";
}

export function ScheduleCenter() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );

  const loadJobs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/schedule", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "加载定时任务失败");
      }
      const nextJobs = data.jobs ?? [];
      setJobs(nextJobs);
      const nextSelected =
        selectedId && nextJobs.some((job: ScheduledJob) => job.id === selectedId)
          ? selectedId
          : nextJobs[0]?.id ?? null;
      setSelectedId(nextSelected);
      const nextJob = nextJobs.find((job: ScheduledJob) => job.id === nextSelected);
      setForm(nextJob ? toForm(nextJob) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载定时任务失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectJob = (job: ScheduledJob) => {
    setSelectedId(job.id);
    setForm(toForm(job));
    setNotice(null);
    setError(null);
  };

  const updateSelectedJob = (updated: ScheduledJob) => {
    setJobs((current) => current.map((job) => (job.id === updated.id ? updated : job)));
    setSelectedId(updated.id);
    setForm(toForm(updated));
  };

  const save = async (overrides: Partial<FormState> = {}) => {
    if (!selectedJob || !form) return;

    const nextForm = { ...form, ...overrides };
    setSaving(true);
    setError(null);
    setNotice(null);

    let payload: Record<string, unknown>;
    try {
      payload = nextForm.payloadText.trim()
        ? JSON.parse(nextForm.payloadText)
        : {};
    } catch {
      setSaving(false);
      setError("payload 必须是合法 JSON");
      return;
    }

    const body: Record<string, unknown> = {
      id: selectedJob.id,
      type: nextForm.type,
      timezone: nextForm.timezone,
      payload,
      enabled: nextForm.enabled,
    };

    if (nextForm.mode === "cron") {
      body.cron = nextForm.cron;
      body.runAt = null;
    } else {
      body.runAt = fromLocalInputValue(nextForm.runAt);
      body.cron = null;
    }

    try {
      const response = await authFetch("/api/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "保存失败");
      }
      updateSelectedJob(data.job);
      setNotice("已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedJob) return;
    const confirmed = window.confirm(`删除任务 ${selectedJob.id}？`);
    if (!confirmed) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/schedule?id=${selectedJob.id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "删除失败");
      }
      const remaining = jobs.filter((job) => job.id !== selectedJob.id);
      setJobs(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setForm(remaining[0] ? toForm(remaining[0]) : null);
      setNotice("已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    const enabled = jobs.filter((job) => job.enabled).length;
    const failed = jobs.filter((job) => job.lastError).length;
    return { enabled, failed, total: jobs.length };
  }, [jobs]);

  return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 text-slate-200">
        <div className="mx-auto max-w-7xl px-5 py-6">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">定时任务</h2>
              <p className="mt-1 text-sm text-slate-500">
                查看任务状态，调整执行时间、payload、启用状态，或删除不再需要的任务。
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-500">
                共 {summary.total} 个 · 运行 {summary.enabled} 个 · 失败 {summary.failed} 个
              </div>
              <button
                type="button"
                onClick={loadJobs}
                disabled={loading}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                刷新
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
              {error}
            </div>
          )}
          {notice && (
            <div className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
              {notice}
            </div>
          )}

          {loading && <div className="mt-8 text-slate-500">加载中...</div>}

          {!loading && jobs.length === 0 && (
            <div className="mt-8 rounded-lg border border-slate-800 px-4 py-10 text-center text-slate-500">
              还没有定时任务。可以在对话中让 Agent 创建，例如“每天早上 9 点生成 LeetCode 练习”。
            </div>
          )}

          {!loading && jobs.length > 0 && (
            <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(520px,1.25fr)]">
              <section className="min-w-0">
                <div className="mb-2 text-xs uppercase tracking-wider text-slate-600">
                  任务列表
                </div>
                <div className="space-y-2">
                  {jobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => selectJob(job)}
                      className={`block w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                        selectedId === job.id
                          ? "border-cyan-700 bg-cyan-950/30"
                          : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-100">
                              {TYPE_LABEL[job.type]}
                            </span>
                            <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(job)}`}>
                              {jobStatusText(job)}
                            </span>
                          </div>
                          <div className="mt-1 truncate font-mono text-xs text-slate-500">
                            {job.id}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-slate-500">
                          <div>{job.cron ? "周期" : "一次性"}</div>
                          <div className="mt-1">{formatDateTime(job.nextRunAt)}</div>
                        </div>
                      </div>
                      <div className="mt-3 line-clamp-2 text-sm text-slate-400">
                        {payloadPreview(job.payload)}
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/40">
                {selectedJob && form ? (
                  <div>
                    <div className="border-b border-slate-800 px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h2 className="text-lg font-medium text-slate-100">
                            编辑任务
                          </h2>
                          <div className="mt-1 font-mono text-xs text-slate-500">
                            {selectedJob.id}
                          </div>
                        </div>
                        <span className={`rounded border px-2 py-1 text-xs ${statusClass(selectedJob)}`}>
                          {jobStatusText(selectedJob)}
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-4 p-5">
                      <label className="grid gap-1.5">
                        <span className="text-sm text-slate-400">任务类型</span>
                        <select
                          value={form.type}
                          onChange={(e) =>
                            setForm({ ...form, type: e.target.value as ScheduledJob["type"] })
                          }
                          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                        >
                          <option value="reminder">提醒</option>
                          <option value="leetcode-daily">LeetCode 每日练习</option>
                          <option value="agent-task">Agent 定时任务</option>
                        </select>
                      </label>

                      <div className="grid gap-2">
                        <span className="text-sm text-slate-400">调度方式</span>
                        <div className="inline-flex w-fit rounded-md border border-slate-700 bg-slate-950 p-1">
                          {(["runAt", "cron"] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setForm({ ...form, mode })}
                              className={`rounded px-3 py-1.5 text-sm ${
                                form.mode === mode
                                  ? "bg-slate-700 text-slate-100"
                                  : "text-slate-500 hover:text-slate-200"
                              }`}
                            >
                              {mode === "runAt" ? "一次性" : "周期"}
                            </button>
                          ))}
                        </div>
                      </div>

                      {form.mode === "runAt" ? (
                        <label className="grid gap-1.5">
                          <span className="text-sm text-slate-400">执行时间</span>
                          <input
                            type="datetime-local"
                            value={form.runAt}
                            onChange={(e) => setForm({ ...form, runAt: e.target.value })}
                            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                          />
                        </label>
                      ) : (
                        <label className="grid gap-1.5">
                          <span className="text-sm text-slate-400">Cron 表达式</span>
                          <input
                            value={form.cron}
                            onChange={(e) => setForm({ ...form, cron: e.target.value })}
                            placeholder="0 9 * * *"
                            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-cyan-600"
                          />
                        </label>
                      )}

                      <label className="grid gap-1.5">
                        <span className="text-sm text-slate-400">时区</span>
                        <input
                          value={form.timezone}
                          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                        />
                      </label>

                      <label className="grid gap-1.5">
                        <span className="text-sm text-slate-400">Payload JSON</span>
                        <textarea
                          value={form.payloadText}
                          onChange={(e) => setForm({ ...form, payloadText: e.target.value })}
                          rows={9}
                          spellCheck={false}
                          className="min-h-44 resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-cyan-600"
                        />
                      </label>

                      <label className="flex items-center gap-3 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={form.enabled}
                          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                          className="h-4 w-4 rounded border-slate-700 bg-slate-950"
                        />
                        启用任务
                      </label>

                      <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-sm">
                        <div>
                          <div className="text-xs text-slate-600">下次执行</div>
                          <div className="mt-1 text-slate-300">{formatDateTime(selectedJob.nextRunAt)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-600">上次执行</div>
                          <div className="mt-1 text-slate-300">{formatDateTime(selectedJob.lastRunAt)}</div>
                        </div>
                        <div className="col-span-2">
                          <div className="text-xs text-slate-600">最近结果</div>
                          <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-slate-400">
                            {selectedJob.lastError || selectedJob.lastResult || "-"}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                        <button
                          type="button"
                          onClick={remove}
                          disabled={saving}
                          className="rounded-md border border-rose-900 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/50 disabled:cursor-not-allowed disabled:text-rose-900"
                        >
                          删除
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => save({ enabled: !form.enabled })}
                            disabled={saving}
                            className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-600"
                          >
                            {form.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            onClick={() => save()}
                            disabled={saving}
                            className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-700"
                          >
                            {saving ? "保存中..." : "保存修改"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="px-5 py-10 text-center text-slate-500">
                    选择一个任务进行编辑。
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
  );
}
