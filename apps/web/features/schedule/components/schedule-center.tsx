"use client";

import { useAuth } from "@web/lib/auth/use-auth";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ChevronRight,
  EllipsisVertical,
  History,
  ListTodo,
  MessageCircle,
  Plus,
  Play,
  Radio,
  RefreshCw,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import { RecurrenceFields } from "./recurrence-fields";
import { defaultRecurrence, describeCron, recurrenceFromCron, recurrenceToCron, type Recurrence } from "../model/recurrence";

type NotificationProvider = "telegram" | "wecom";
type ScheduledOutputChannel = "inapp" | NotificationProvider;
type ScheduleTab = "tasks" | "channels";

type ScheduledModel = {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  modelId: string;
  enabled: boolean;
  supportsTools: boolean;
};

type NotificationChannel = {
  provider: NotificationProvider;
  label: string;
  enabled: boolean;
  configured: boolean;
  credentialsHint: string;
  settings: { chatId?: string };
  lastTestStatus?: "success" | "failed";
  lastTestError?: string;
};

type ScheduledDelivery = {
  id: string;
  jobId: string;
  provider: NotificationProvider;
  status: "pending" | "sending" | "delivered" | "retry_wait" | "dead";
  attemptCount: number;
  lastError: string | null;
};

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
};

type ScheduledJobRun = {
  id: number;
  jobId: string;
  status: "running" | "success" | "failed" | "skipped";
  result: string | null;
  error: string | null;
  scheduledFor: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

type FormState = {
  name: string;
  type: ScheduledJob["type"];
  mode: "runAt" | "cron";
  runAt: string;
  recurrence: Recurrence;
  timezone: string;
  content: string;
  modelId: string;
  extraPayloadText: string;
  channels: ScheduledOutputChannel[];
  enabled: boolean;
};

type ChannelDraft = {
  enabled: boolean;
  botToken: string;
  chatId: string;
  webhookUrl: string;
};

const TYPE_LABEL: Record<ScheduledJob["type"], string> = {
  reminder: "提醒",
  "leetcode-daily": "LeetCode 每日练习",
  "agent-task": "Agent 定时任务",
};

const DELIVERY_LABEL: Record<ScheduledDelivery["status"], string> = {
  pending: "等待投递",
  sending: "投递中",
  delivered: "已送达",
  retry_wait: "等待重试",
  dead: "投递失败",
};

function emptyForm(): FormState {
  return {
    name: "",
    type: "agent-task",
    mode: "cron",
    runAt: "",
    recurrence: defaultRecurrence(),
    timezone: "Asia/Shanghai",
    content: "",
    modelId: "",
    extraPayloadText: "{}",
    channels: ["inapp"],
    enabled: true,
  };
}

function formatDateTime(value?: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function relativeTime(value?: number | null) {
  if (!value) return "尚未运行";
  const delta = Math.max(0, Date.now() - value);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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

function payloadContent(job: ScheduledJob) {
  if (job.type === "agent-task" && typeof job.payload.prompt === "string") {
    return job.payload.prompt;
  }
  if (job.type === "reminder" && typeof job.payload.text === "string") {
    return job.payload.text;
  }
  return "";
}

function jobName(job: ScheduledJob) {
  if (typeof job.payload.name === "string" && job.payload.name.trim()) {
    return job.payload.name.trim();
  }
  return payloadContent(job).trim().slice(0, 40) || TYPE_LABEL[job.type];
}

function jobDescription(job: ScheduledJob) {
  const content = payloadContent(job).trim();
  const explicitName = typeof job.payload.name === "string" ? job.payload.name.trim() : "";
  if (content && (!explicitName || !content.startsWith(explicitName))) {
    return content;
  }
  return job.cron
    ? describeCron(job.cron, job.timezone)
    : `一次性 · ${formatDateTime(job.runAt)}`;
}

function toForm(job: ScheduledJob): FormState {
  const extraPayload = { ...(job.payload ?? {}) };
  const configuredChannels = Array.isArray(extraPayload.channels)
    ? extraPayload.channels.filter(
      (item): item is ScheduledOutputChannel =>
        item === "inapp" || item === "telegram" || item === "wecom",
    )
    : [];
  const channels = Array.from(new Set<ScheduledOutputChannel>(["inapp", ...configuredChannels]));
  delete extraPayload.name;
  delete extraPayload.prompt;
  delete extraPayload.text;
  delete extraPayload.modelId;
  delete extraPayload.channels;
  return {
    name: typeof job.payload.name === "string" ? job.payload.name : "",
    type: job.type,
    mode: job.cron ? "cron" : "runAt",
    runAt: toLocalInputValue(job.runAt),
    recurrence: job.cron ? recurrenceFromCron(job.cron) : defaultRecurrence(),
    timezone: job.timezone || "Asia/Shanghai",
    content: payloadContent(job),
    modelId: typeof job.payload.modelId === "string" ? job.payload.modelId : "",
    extraPayloadText: JSON.stringify(extraPayload, null, 2),
    channels,
    enabled: job.enabled,
  };
}

function statusText(job: ScheduledJob) {
  if (!job.enabled) return "已停用";
  if (job.lastError) return "执行失败";
  if (job.nextRunAt < Date.now()) return "已逾期";
  return "已启用";
}

function setTaskUrl(taskId?: string, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("panel", "schedule");
  if (taskId) url.searchParams.set("scheduleTask", taskId);
  else url.searchParams.delete("scheduleTask");
  url.searchParams.delete("scheduleRuns");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function setRunsUrl(jobId?: string, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("panel", "schedule");
  url.searchParams.delete("scheduleTask");
  if (jobId) url.searchParams.set("scheduleRuns", jobId);
  else url.searchParams.delete("scheduleRuns");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

export function ScheduleCenter() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<ScheduleTab>("tasks");
  const [detailMode, setDetailMode] = useState(false);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyLoadedFor, setHistoryLoadedFor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  const [models, setModels] = useState<ScheduledModel[]>([]);
  const [deliveries, setDeliveries] = useState<ScheduledDelivery[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [channelDrafts, setChannelDrafts] = useState<Record<NotificationProvider, ChannelDraft>>({
    telegram: { enabled: false, botToken: "", chatId: "", webhookUrl: "" },
    wecom: { enabled: false, botToken: "", chatId: "", webhookUrl: "" },
  });
  const [channelBusy, setChannelBusy] = useState<NotificationProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === editingId) ?? null,
    [editingId, jobs],
  );
  const latestDelivery = useMemo(
    () => deliveries.find((delivery) => delivery.jobId === editingId) ?? null,
    [deliveries, editingId],
  );
  const historyJob = useMemo(
    () => jobs.find((job) => job.id === historyJobId) ?? null,
    [historyJobId, jobs],
  );
  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  const syncChannelDrafts = useCallback((nextChannels: NotificationChannel[]) => {
    setChannelDrafts((current) => ({
      telegram: {
        ...current.telegram,
        enabled: nextChannels.find((item) => item.provider === "telegram")?.enabled ?? false,
        chatId: nextChannels.find((item) => item.provider === "telegram")?.settings?.chatId ?? "",
      },
      wecom: {
        ...current.wecom,
        enabled: nextChannels.find((item) => item.provider === "wecom")?.enabled ?? false,
      },
    }));
  }, []);

  const loadData = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [jobResponse, channelResponse, modelResponse] = await Promise.all([
        authFetch("/api/schedule", { cache: "no-store" }),
        authFetch("/api/settings/notification-channels", { cache: "no-store" }),
        authFetch("/api/llm/providers", { cache: "no-store" }),
      ]);
      const [jobData, channelData, modelData] = await Promise.all([
        jobResponse.json(),
        channelResponse.json(),
        modelResponse.json(),
      ]);
      if (!jobResponse.ok || !jobData.ok) {
        throw new Error(jobData.error || "加载定时任务失败");
      }
      if (!channelResponse.ok || !channelData.ok) {
        throw new Error(channelData.error || "加载消息通道失败");
      }
      if (!modelResponse.ok) {
        throw new Error(modelData.error || "加载模型配置失败");
      }
      setJobs(jobData.jobs ?? []);
      setDeliveries(jobData.deliveries ?? []);
      setChannels(channelData.channels ?? []);
      const enabledProviders = new Set(
        (modelData.providers ?? []).filter((provider: { enabled: boolean }) => provider.enabled)
          .map((provider: { id: string }) => provider.id),
      );
      setModels((modelData.models ?? []).filter(
        (model: ScheduledModel) =>
          model.enabled && model.supportsTools && enabledProviders.has(model.providerId),
      ));
      syncChannelDrafts(channelData.channels ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载定时任务失败");
    } finally {
      setLoading(false);
    }
  }, [user, syncChannelDrafts]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const syncFromUrl = () => {
      const params = new URL(window.location.href).searchParams;
      const runsId = params.get("scheduleRuns");
      const taskId = params.get("scheduleTask");
      if (runsId) {
        setActiveTab("tasks");
        setDetailMode(false);
        setEditingId(null);
        setHistoryJobId(runsId);
        return;
      }
      if (!taskId) {
        setDetailMode(false);
        setEditingId(null);
        setHistoryJobId(null);
        return;
      }
      setActiveTab("tasks");
      setDetailMode(true);
      setHistoryJobId(null);
      if (taskId === "new") {
        setEditingId(null);
        setForm(emptyForm());
        return;
      }
      const job = jobs.find((item) => item.id === taskId);
      if (job) {
        setEditingId(job.id);
        setForm(toForm(job));
      } else if (!loading) {
        setDetailMode(false);
        setEditingId(null);
        setTaskUrl(undefined, true);
      }
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [jobs, loading]);

  const selectTab = (tab: ScheduleTab) => {
    setActiveTab(tab);
    setDetailMode(false);
    setEditingId(null);
    setHistoryJobId(null);
    setError(null);
    setNotice(null);
    const url = new URL(window.location.href);
    url.searchParams.set("panel", "schedule");
    url.searchParams.delete("scheduleTask");
    url.searchParams.delete("scheduleRuns");
    window.history.replaceState({}, "", url);
  };

  const openTask = (job: ScheduledJob) => {
    setEditingId(job.id);
    setForm(toForm(job));
    setDetailMode(true);
    setHistoryJobId(null);
    setError(null);
    setNotice(null);
    setTaskUrl(job.id);
  };

  const startCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setDetailMode(true);
    setHistoryJobId(null);
    setError(null);
    setNotice(null);
    setTaskUrl("new");
  };

  const backToTasks = () => {
    setDetailMode(false);
    setEditingId(null);
    setHistoryJobId(null);
    setError(null);
    setNotice(null);
    setTaskUrl(undefined, true);
  };

  const updateChannelDraft = (provider: NotificationProvider, patch: Partial<ChannelDraft>) => {
    setChannelDrafts((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }));
  };

  const saveChannel = async (provider: NotificationProvider) => {
    setChannelBusy(provider);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/settings/notification-channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...channelDrafts[provider] }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存消息通道失败");
      const nextChannels = [
        ...channels.filter((item) => item.provider !== provider),
        data.channel,
      ];
      setChannels(nextChannels);
      syncChannelDrafts(nextChannels);
      updateChannelDraft(provider, provider === "telegram" ? { botToken: "" } : { webhookUrl: "" });
      setNotice(`${data.channel.label} 已保存`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存消息通道失败");
    } finally {
      setChannelBusy(null);
    }
  };

  const testChannel = async (provider: NotificationProvider) => {
    setChannelBusy(provider);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/settings/notification-channels/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "测试消息发送失败");
      setNotice("测试消息已发送");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试消息发送失败");
    } finally {
      setChannelBusy(null);
    }
  };

  const taskPayload = () => {
    let extraPayload: Record<string, unknown>;
    try {
      extraPayload = form.extraPayloadText.trim() ? JSON.parse(form.extraPayloadText) : {};
    } catch {
      throw new Error("高级参数必须是合法 JSON");
    }
    const payload: Record<string, unknown> = {
      ...extraPayload,
      name: form.name.trim(),
      channels: form.channels,
    };
    delete payload.prompt;
    delete payload.text;
    delete payload.modelId;
    if (form.type === "agent-task" && form.modelId) payload.modelId = form.modelId;
    if (form.type === "agent-task") payload.prompt = form.content.trim();
    if (form.type === "reminder") payload.text = form.content.trim();
    return payload;
  };

  const saveTask = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        type: form.type,
        timezone: form.timezone,
        payload: taskPayload(),
        enabled: form.enabled,
      };
      if (editingId) body.id = editingId;
      if (form.mode === "cron") {
        body.cron = recurrenceToCron(form.recurrence);
        body.runAt = null;
      } else {
        body.runAt = fromLocalInputValue(form.runAt);
        body.cron = null;
      }
      const response = await authFetch("/api/schedule", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存任务失败");
      setJobs((current) => editingId
        ? current.map((job) => job.id === data.job.id ? data.job : job)
        : [data.job, ...current.filter((job) => job.id !== data.job.id)]);
      setEditingId(data.job.id);
      setForm(toForm(data.job));
      const url = new URL(window.location.href);
      url.searchParams.set("scheduleTask", data.job.id);
      window.history.replaceState({}, "", url);
      setNotice(editingId ? "任务修改已保存" : "任务已创建");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存任务失败");
    } finally {
      setSaving(false);
    }
  };

  const deleteTask = async (job: ScheduledJob) => {
    if (!window.confirm(`删除任务“${jobName(job)}”？`)) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/schedule?id=${job.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "删除任务失败");
      setJobs((current) => current.filter((item) => item.id !== job.id));
      if (editingId === job.id) backToTasks();
      setNotice("任务已删除");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除任务失败");
    } finally {
      setSaving(false);
    }
  };

  const rescheduleTask = async () => {
    if (!selectedJob?.cron) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedJob.id, reschedule: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "重新排期失败");
      setJobs((current) => current.map((job) => job.id === data.job.id ? data.job : job));
      setForm(toForm(data.job));
      setNotice(selectedJob.enabled ? "任务已重新排期" : "任务已重新排期，启用后执行");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新排期失败");
    } finally {
      setSaving(false);
    }
  };

  const openRunHistory = async (job: ScheduledJob, replace = false) => {
    setHistoryJobId(job.id);
    setDetailMode(false);
    setEditingId(null);
    setRuns([]);
    setHistoryLoadedFor(null);
    setSelectedRunId(null);
    setLoading(true);
    setError(null);
    setNotice(null);
    setRunsUrl(job.id, replace);
    try {
      const response = await authFetch(`/api/schedule/${job.id}/runs`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "读取运行记录失败");
      setRuns(data.runs ?? []);
      setSelectedRunId(data.runs?.[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取运行记录失败");
    } finally {
      setHistoryLoadedFor(job.id);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user || !historyJobId || historyLoadedFor === historyJobId || loading) return;
    const job = jobs.find((item) => item.id === historyJobId);
    if (job) void openRunHistory(job, true);
  }, [historyJobId, historyLoadedFor, jobs, loading, user]);

  const runTaskNow = async (job: ScheduledJob) => {
    setRunningId(job.id);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/schedule/${job.id}/run`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "任务执行失败，请在运行记录中查看详情");
      }
      setNotice(`“${jobName(job)}”运行完成`);
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "立即运行失败");
    } finally {
      setRunningId(null);
    }
  };

  const toggleTask = async (job: ScheduledJob, enabled: boolean) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, enabled }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "更新任务失败");
      setJobs((current) => current.map((item) => item.id === data.job.id ? data.job : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新任务失败");
    } finally {
      setSaving(false);
    }
  };

  const tabBar = (
    <div className="flex border-b border-slate-800" data-guest-browse role="tablist" aria-label="定时任务视图">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "tasks"}
        onClick={() => selectTab("tasks")}
        className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm ${activeTab === "tasks" ? "border-cyan-500 text-slate-100" : "border-transparent text-slate-500 hover:text-slate-300"}`}
      >
        <ListTodo className="h-4 w-4" aria-hidden="true" />
        任务列表
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "channels"}
        onClick={() => selectTab("channels")}
        className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm ${activeTab === "channels" ? "border-cyan-500 text-slate-100" : "border-transparent text-slate-500 hover:text-slate-300"}`}
      >
        <Radio className="h-4 w-4" aria-hidden="true" />
        消息通道
      </button>
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        {historyJobId ? (
          <RunHistory
            job={historyJob}
            runs={runs}
            selectedRun={selectedRun}
            loading={loading}
            error={error}
            onBack={backToTasks}
            onSelect={setSelectedRunId}
          />
        ) : detailMode ? (
          <TaskDetail
            form={form}
            setForm={setForm}
            isNew={!editingId}
            selectedJob={selectedJob}
            latestDelivery={latestDelivery}
            channels={channels}
            models={models}
            saving={saving}
            error={error}
            notice={notice}
            onBack={backToTasks}
            onSave={saveTask}
            onReschedule={rescheduleTask}
          />
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-3 pb-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-100">定时任务</h2>
                <p className="mt-1 text-sm text-slate-500">
                  管理自动执行内容与消息投递通道。
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadData()}
                disabled={loading}
                aria-label="刷新"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:bg-slate-900 hover:text-slate-200 disabled:cursor-not-allowed disabled:text-slate-700"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              </button>
            </header>
            {tabBar}
            {error && <div role="alert" className="mt-4 border-l-2 border-rose-700 px-3 py-2 text-sm text-rose-300">{error}</div>}
            {notice && <div className="mt-4 border-l-2 border-emerald-700 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
            {activeTab === "tasks" ? (
              <TaskList
                jobs={jobs}
                loading={loading}
                saving={saving}
                onCreate={startCreate}
                onOpen={openTask}
                onDelete={deleteTask}
                onToggle={toggleTask}
                onRun={runTaskNow}
                onViewRuns={openRunHistory}
                runningId={runningId}
              />
            ) : (
              <ChannelList
                channels={channels}
                drafts={channelDrafts}
                busy={channelBusy}
                onDraftChange={updateChannelDraft}
                onSave={saveChannel}
                onTest={testChannel}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TaskList(props: {
  jobs: ScheduledJob[];
  loading: boolean;
  saving: boolean;
  onCreate: () => void;
  onOpen: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onToggle: (job: ScheduledJob, enabled: boolean) => void;
  onRun: (job: ScheduledJob) => void;
  onViewRuns: (job: ScheduledJob) => void;
  runningId: string | null;
}) {
  const { user } = useAuth();
  const [menuId, setMenuId] = useState<string | null>(null);
  return (
    <section role="tabpanel" className="pt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-slate-500">{user ? `${props.jobs.length} 个任务` : "登录后查看任务"}</span>
        <button
          type="button"
          onClick={props.onCreate}
          className="flex h-9 items-center gap-2 rounded-md bg-cyan-700 px-3 text-sm font-medium text-white hover:bg-cyan-600"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          新建任务
        </button>
      </div>

      {props.loading ? (
        <div className="py-12 text-center text-sm text-slate-500">加载中...</div>
      ) : props.jobs.length === 0 ? (
        <div className="border-y border-slate-800 py-16 text-center text-sm text-slate-500">
          {user ? "暂无定时任务" : "登录后查看和管理定时任务"}
        </div>
      ) : (
        <div className="divide-y divide-slate-800 border-y border-slate-800">
          {props.jobs.map((job) => (
            <div key={job.id} className="relative flex min-h-24 min-w-0 items-center gap-3 py-3">
              <button
                type="button"
                onClick={() => props.onOpen(job)}
                className="min-w-0 flex-1 overflow-hidden rounded-md px-3 py-2 text-left hover:bg-slate-900/60"
              >
                <div className="min-w-0 overflow-hidden">
                  <div className="truncate text-sm font-medium text-slate-100">{jobName(job)}</div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
                    <span className={job.lastError ? "text-rose-400" : job.lastRunAt ? "text-emerald-400" : "text-slate-500"}>
                      {job.lastError ? "执行失败" : job.lastRunAt ? "执行成功" : statusText(job)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(job.lastRunAt)}</span>
                    <span className="hidden truncate sm:inline">· {jobDescription(job)}</span>
                  </div>
                </div>
              </button>

              <button
                type="button"
                role="switch"
                aria-checked={job.enabled}
                aria-label={`${job.enabled ? "停用" : "启用"} ${jobName(job)}`}
                onClick={() => props.onToggle(job, !job.enabled)}
                disabled={props.saving || props.runningId === job.id}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${job.enabled ? "bg-cyan-600" : "bg-slate-700"} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${job.enabled ? "translate-x-5" : "translate-x-0"}`} />
              </button>

              <button
                type="button"
                onClick={() => props.onRun(job)}
                disabled={props.runningId !== null}
                aria-label={`立即运行 ${jobName(job)}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-700 text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-700"
              >
                {props.runningId === job.id
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <Play className="h-4 w-4 fill-current" aria-hidden="true" />}
              </button>

              <button
                type="button"
                onClick={() => setMenuId((current) => current === job.id ? null : job.id)}
                aria-label={`${jobName(job)} 更多操作`}
                aria-expanded={menuId === job.id}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-800 text-slate-500 hover:bg-slate-900 hover:text-slate-200"
              >
                <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
              </button>

              {menuId === job.id && (
                <div className="absolute right-0 top-14 z-20 w-44 rounded-md border border-slate-700 bg-slate-900 p-1 shadow-xl">
                  <button
                    type="button"
                    onClick={() => { setMenuId(null); props.onViewRuns(job); }}
                    className="flex h-9 w-full items-center gap-2 rounded px-3 text-left text-sm text-slate-200 hover:bg-slate-800"
                  >
                    <History className="h-4 w-4" aria-hidden="true" />
                    查看运行记录
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMenuId(null); props.onOpen(job); }}
                    className="flex h-9 w-full items-center gap-2 rounded px-3 text-left text-sm text-slate-200 hover:bg-slate-800"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    编辑任务
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMenuId(null); props.onDelete(job); }}
                    className="flex h-9 w-full items-center gap-2 rounded px-3 text-left text-sm text-rose-300 hover:bg-rose-950/40"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TaskDetail(props: {
  form: FormState;
  setForm: (form: FormState) => void;
  isNew: boolean;
  selectedJob: ScheduledJob | null;
  latestDelivery: ScheduledDelivery | null;
  channels: NotificationChannel[];
  models: ScheduledModel[];
  saving: boolean;
  error: string | null;
  notice: string | null;
  onBack: () => void;
  onSave: () => void;
  onReschedule: () => void;
}) {
  const { form, setForm } = props;
  return (
    <section>
      <header className="flex items-center gap-3 border-b border-slate-800 pb-4">
        <button
          type="button"
          onClick={props.onBack}
          aria-label="返回任务列表"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-100">
            {props.isNew ? "新建任务" : jobName(props.selectedJob!)}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {props.isNew ? "配置任务内容、执行时间与推送通道" : "任务详情"}
          </p>
        </div>
      </header>

      {props.error && <div role="alert" className="mt-4 border-l-2 border-rose-700 px-3 py-2 text-sm text-rose-300">{props.error}</div>}
      {props.notice && <div className="mt-4 border-l-2 border-emerald-700 px-3 py-2 text-sm text-emerald-300">{props.notice}</div>}

      <div className="grid max-w-3xl gap-5 py-6">
        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">任务名称</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
          />
        </label>

        <label className="grid gap-1.5">
          <span className="text-sm text-slate-400">任务类型</span>
          <select
            value={form.type}
            onChange={(event) => setForm({ ...form, type: event.target.value as ScheduledJob["type"] })}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
          >
            <option value="agent-task">Agent 定时任务</option>
            <option value="reminder">提醒</option>
            <option value="leetcode-daily">LeetCode 每日练习</option>
          </select>
        </label>

        {form.type !== "leetcode-daily" && (
          <label className="grid gap-1.5">
            <span className="text-sm text-slate-400">
              {form.type === "agent-task" ? "执行内容" : "提醒内容"}
            </span>
            <textarea
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              rows={7}
              className="min-h-36 resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm leading-6 text-slate-100 outline-none focus:border-cyan-600"
            />
          </label>
        )}

        {form.type === "agent-task" && (
          <label className="grid gap-1.5">
            <span className="text-sm text-slate-400">执行模型</span>
            <select
              value={form.modelId}
              onChange={(event) => setForm({ ...form, modelId: event.target.value })}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
            >
              <option value="">用户默认模型</option>
              {form.modelId && !props.models.some((model) => model.id === form.modelId) && (
                <option value={form.modelId} disabled>当前模型已停用或删除</option>
              )}
              {props.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.providerName} / {model.displayName}
                </option>
              ))}
            </select>
            {props.models.length === 0 && (
              <span className="text-xs text-amber-400">请先在大语言模型设置中配置并启用模型</span>
            )}
          </label>
        )}

        <fieldset className="grid gap-2">
          <legend className="text-sm text-slate-400">什么时候执行</legend>
          <div className="inline-flex w-fit rounded-md border border-slate-700 bg-slate-950 p-1">
            {(["runAt", "cron"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={form.mode === mode}
                onClick={() => setForm({ ...form, mode })}
                className={`rounded px-3 py-1.5 text-sm ${form.mode === mode ? "bg-slate-700 text-slate-100" : "text-slate-500 hover:text-slate-200"}`}
              >
                {mode === "runAt" ? "仅执行一次" : "重复执行"}
              </button>
            ))}
          </div>
        </fieldset>

        {form.mode === "runAt" ? (
          <label className="grid gap-1.5">
            <span className="text-sm text-slate-400">执行时间</span>
            <input
              type="datetime-local"
              value={form.runAt}
              onChange={(event) => setForm({ ...form, runAt: event.target.value })}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
            />
            <span className="text-xs text-slate-500">按当前设备的本地时间执行，仅运行一次。</span>
          </label>
        ) : (
          <RecurrenceFields
            value={form.recurrence}
            timezone={form.timezone}
            onChange={(recurrence) => setForm({ ...form, recurrence })}
            onTimezoneChange={(timezone) => setForm({ ...form, timezone })}
          />
        )}

        <fieldset className="grid gap-2">
          <legend className="text-sm text-slate-400">结果输出</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex min-h-9 items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked
                disabled
                className="h-4 w-4 rounded border-slate-700 bg-slate-950"
              />
              站内预览
            </label>
            {(["telegram", "wecom"] as const).map((provider) => {
              const channel = props.channels.find((item) => item.provider === provider);
              return (
                <label key={provider} className="flex min-h-9 items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.channels.includes(provider)}
                    disabled={!channel?.enabled}
                    onChange={(event) => setForm({
                      ...form,
                      channels: event.target.checked
                        ? Array.from(new Set([...form.channels, provider]))
                        : form.channels.filter((item) => item !== provider),
                    })}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-950"
                  />
                  {provider === "telegram" ? "Telegram" : "企业微信"}
                </label>
              );
            })}
          </div>
        </fieldset>

        <details className="border-y border-slate-800 py-3">
          <summary className="cursor-pointer text-sm text-slate-400">高级参数</summary>
          <p className="mt-3 text-xs text-slate-500">通常无需修改，保持默认即可。仅在任务需要额外参数时填写 JSON。</p>
          <textarea
            value={form.extraPayloadText}
            onChange={(event) => setForm({ ...form, extraPayloadText: event.target.value })}
            rows={6}
            spellCheck={false}
            className="mt-3 min-h-28 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-cyan-600"
          />
        </details>

        <label className="flex min-h-10 items-center gap-3 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950"
          />
          启用任务
        </label>

        {props.selectedJob && (
          <div className="grid gap-4 border-y border-slate-800 py-4 text-sm sm:grid-cols-2">
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-600">
                    {props.selectedJob.nextRunAt < Date.now() ? "已错过执行时间" : "下次执行"}
                  </div>
                  <div className={`mt-1 ${props.selectedJob.nextRunAt < Date.now() ? "text-amber-300" : "text-slate-300"}`}>
                    {formatDateTime(props.selectedJob.nextRunAt)}
                  </div>
                </div>
                {props.selectedJob.cron && props.selectedJob.nextRunAt < Date.now() && (
                  <button
                    type="button"
                    onClick={props.onReschedule}
                    disabled={props.saving}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-800 px-2.5 text-xs text-amber-300 hover:bg-amber-950/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    重新排期
                  </button>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-600">上次执行</div>
              <div className="mt-1 text-slate-300">{formatDateTime(props.selectedJob.lastRunAt)}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs text-slate-600">最近投递</div>
              <div className="mt-1 text-slate-400">
                {props.latestDelivery
                  ? `${props.latestDelivery.provider} · ${DELIVERY_LABEL[props.latestDelivery.status]}${props.latestDelivery.lastError ? ` · ${props.latestDelivery.lastError}` : ""}`
                  : "-"}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.saving}
            className="flex h-10 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {props.saving ? "保存中..." : props.isNew ? "创建任务" : "保存修改"}
          </button>
        </div>
      </div>
    </section>
  );
}

function runStatusLabel(status: ScheduledJobRun["status"]) {
  if (status === "success") return "执行成功";
  if (status === "failed") return "执行失败";
  if (status === "running") return "执行中";
  return "已跳过";
}

function runStatusClass(status: ScheduledJobRun["status"]) {
  if (status === "success") return "text-emerald-400";
  if (status === "failed") return "text-rose-400";
  if (status === "running") return "text-cyan-400";
  return "text-slate-500";
}

function RunHistory(props: {
  job: ScheduledJob | null;
  runs: ScheduledJobRun[];
  selectedRun: ScheduledJobRun | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onSelect: (id: number) => void;
}) {
  return (
    <section>
      <header className="flex items-center gap-3 border-b border-slate-800 pb-4">
        <button
          type="button"
          onClick={props.onBack}
          aria-label="返回任务列表"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-100">
            {props.job ? jobName(props.job) : "运行记录"}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">历史任务结果与站内预览</p>
        </div>
      </header>

      {props.error && (
        <div role="alert" className="mt-4 border-l-2 border-rose-700 px-3 py-2 text-sm text-rose-300">
          {props.error}
        </div>
      )}

      {props.loading ? (
        <div className="py-16 text-center text-sm text-slate-500">加载运行记录...</div>
      ) : props.runs.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-500">暂无运行记录</div>
      ) : (
        <div className="grid min-h-[32rem] gap-5 pt-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="divide-y divide-slate-800 border-y border-slate-800">
            {props.runs.map((run) => {
              const selected = props.selectedRun?.id === run.id;
              const timestamp = run.finishedAt ? Date.parse(run.finishedAt) : run.scheduledFor;
              const modelName = typeof run.metadata?.modelName === "string"
                ? run.metadata.modelName
                : null;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => props.onSelect(run.id)}
                  className={`block w-full px-3 py-4 text-left ${selected ? "bg-slate-900" : "hover:bg-slate-900/60"}`}
                >
                  <div className={`text-sm font-medium ${runStatusClass(run.status)}`}>
                    {runStatusLabel(run.status)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{formatDateTime(timestamp)}</div>
                  {modelName && <div className="mt-1 truncate text-xs text-slate-600">{modelName}</div>}
                </button>
              );
            })}
          </div>

          <article className="min-w-0 border-t border-slate-800 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            {props.selectedRun && (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
                  <div>
                    <div className={`text-sm font-medium ${runStatusClass(props.selectedRun.status)}`}>
                      {runStatusLabel(props.selectedRun.status)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {formatDateTime(props.selectedRun.finishedAt
                        ? Date.parse(props.selectedRun.finishedAt)
                        : props.selectedRun.scheduledFor)}
                    </div>
                  </div>
                  {typeof props.selectedRun.metadata?.modelName === "string" && (
                    <div className="text-right text-xs text-slate-500">
                      <div>{props.selectedRun.metadata.modelName}</div>
                      {typeof props.selectedRun.metadata.modelId === "string" && (
                        <div className="mt-1 font-mono text-slate-600">{props.selectedRun.metadata.modelId}</div>
                      )}
                    </div>
                  )}
                </div>
                <div className="py-5">
                  {props.selectedRun.error ? (
                    <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-rose-300">
                      {props.selectedRun.error}
                    </pre>
                  ) : props.selectedRun.result ? (
                    <div className="max-w-none break-words text-sm leading-6 text-slate-300 [&_a]:text-cyan-400 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-700 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-slate-900 [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-medium [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-medium [&_li]:ml-5 [&_li]:list-disc [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-900 [&_pre]:p-3">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.selectedRun.result}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-600">本次运行暂无结果内容</div>
                  )}
                </div>
              </>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

function ChannelList(props: {
  channels: NotificationChannel[];
  drafts: Record<NotificationProvider, ChannelDraft>;
  busy: NotificationProvider | null;
  onDraftChange: (provider: NotificationProvider, patch: Partial<ChannelDraft>) => void;
  onSave: (provider: NotificationProvider) => void;
  onTest: (provider: NotificationProvider) => void;
}) {
  return (
    <section role="tabpanel" className="pt-5">
      <div className="grid gap-4 lg:grid-cols-2">
        {(["telegram", "wecom"] as const).map((provider) => {
          const channel = props.channels.find((item) => item.provider === provider);
          const draft = props.drafts[provider];
          return (
            <div key={provider} className="rounded-md border border-slate-800 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
                  <span className="text-sm font-medium text-slate-200">
                    {provider === "telegram" ? "Telegram Bot" : "企业微信群机器人"}
                  </span>
                </div>
                <label className="flex min-h-9 items-center gap-2 text-sm text-slate-400">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => props.onDraftChange(provider, { enabled: event.target.checked })}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-950"
                  />
                  启用
                </label>
              </div>

              <div className="mt-4 grid gap-3">
                {provider === "telegram" ? (
                  <>
                    <label className="grid gap-1.5">
                      <span className="text-xs text-slate-500">Bot Token</span>
                      <input
                        type="password"
                        value={draft.botToken}
                        onChange={(event) => props.onDraftChange(provider, { botToken: event.target.value })}
                        placeholder={channel?.configured ? `已配置 ${channel.credentialsHint}` : ""}
                        autoComplete="new-password"
                        className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-xs text-slate-500">Chat ID</span>
                      <input
                        value={draft.chatId}
                        onChange={(event) => props.onDraftChange(provider, { chatId: event.target.value })}
                        className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                      />
                    </label>
                  </>
                ) : (
                  <label className="grid gap-1.5">
                    <span className="text-xs text-slate-500">群机器人 Webhook URL</span>
                    <input
                      type="password"
                      value={draft.webhookUrl}
                      onChange={(event) => props.onDraftChange(provider, { webhookUrl: event.target.value })}
                      placeholder={channel?.configured ? `已配置 ${channel.credentialsHint}` : ""}
                      autoComplete="new-password"
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600"
                    />
                  </label>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className={`min-w-0 text-xs ${channel?.lastTestStatus === "failed" ? "text-rose-400" : "text-slate-500"}`}>
                  {channel?.lastTestStatus === "success"
                    ? "连接测试成功"
                    : channel?.lastTestStatus === "failed"
                      ? channel.lastTestError || "连接测试失败"
                      : "尚未测试"}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => props.onTest(provider)}
                    disabled={props.busy !== null || !channel?.enabled}
                    className="flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:cursor-not-allowed disabled:text-slate-600"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    测试
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onSave(provider)}
                    disabled={props.busy !== null}
                    className="flex h-9 items-center gap-2 rounded-md bg-cyan-700 px-3 text-sm text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-700"
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    保存
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
