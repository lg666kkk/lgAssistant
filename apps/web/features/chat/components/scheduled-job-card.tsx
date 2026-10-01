const types: Record<string, string> = { reminder: "提醒", "leetcode-daily": "LeetCode 练习", "agent-task": "Agent 任务" };
const channels: Record<string, string> = { inapp: "站内任务结果", telegram: "Telegram", wecom: "企业微信" };

export function readScheduledJobDraft(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const payload = data.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {};
  const timezone = typeof data.timezone === "string" ? data.timezone : "Asia/Shanghai";
  let time = "未提供执行时间";
  if (typeof data.cron === "string") time = `周期执行（cron：${data.cron}）`;
  else if (typeof data.runAt === "string") {
    try {
      time = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(data.runAt));
    } catch { time = "时间或时区无效，请取消后修改"; }
  }
  const outputs = Array.isArray(payload.channels) ? payload.channels.filter((item): item is string => typeof item === "string") : [];
  return {
    name: typeof payload.name === "string" ? payload.name : "定时任务",
    type: types[String(data.type)] ?? "未知类型",
    time,
    timezone,
    content: typeof payload.prompt === "string" ? payload.prompt : typeof payload.text === "string" ? payload.text : data.type === "leetcode-daily" ? "生成每日 LeetCode 练习" : "未提供任务内容",
    outputs: Array.from(new Set(["inapp", ...outputs])).map(item => channels[item] ?? item).join("、"),
    model: data.type === "agent-task" ? typeof payload.modelId === "string" ? `指定模型（${payload.modelId}）` : "用户默认模型" : null,
  };
}

export function ScheduledJobCard({ input }: { input: unknown }) {
  const draft = readScheduledJobDraft(input);
  if (!draft) return <p className="ml-3.5 mt-2 text-amber-200">任务参数缺失，请取消后重试。</p>;
  return (
    <section aria-label="定时任务创建确认" className="ml-3.5 mt-2 space-y-2 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 text-xs">
      <h3 className="text-sm font-medium text-slate-100">{draft.name}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-slate-500">类型</dt><dd>{draft.type}</dd>
        <dt className="text-slate-500">执行时间</dt><dd className="break-words">{draft.time}</dd>
        <dt className="text-slate-500">时区</dt><dd>{draft.timezone}</dd>
        <dt className="text-slate-500">任务内容</dt><dd className="whitespace-pre-wrap break-words">{draft.content}</dd>
        <dt className="text-slate-500">输出位置</dt><dd>{draft.outputs}</dd>
        {draft.model && <><dt className="text-slate-500">模型</dt><dd className="break-all">{draft.model}</dd></>}
      </dl>
      <p className="text-slate-400">尚未创建；确认后保存。站内结果需在定时任务页面查看，外部推送需配置对应通道。修改请取消后在对话中说明。</p>
    </section>
  );
}
