"use client";
import { memo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { useChatManager } from "./_hooks/use-chat-manager";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./_components/chat/chat-input";
import { ImagePreviewDialog, type PreviewImage } from "./_components/chat/image-preview-dialog";
import type { ModelUsageEventData } from "@/lib/agent/runtime/events";
import type { PlanProgressEventData } from "@/lib/agent/runtime/events";
import type { ExecutionPlanData } from "@/lib/agent/runtime/events";
import type { PlanExecutionControlData } from "@/lib/agent/runtime/events";
import type { ReasoningEventData } from "@/lib/agent/runtime/events";
import {
  defaultChatModel,
  supportsImageInput,
  type ChatModelId,
} from "@/lib/agent/models";
import {
  MAX_IMAGE_COUNT,
  MAX_SINGLE_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  type ChatImageAttachment,
  type SupportedImageMediaType,
} from "@/lib/agent/multimodal";
import { Image as ImageIcon } from "lucide-react";
import { AuthGate } from "@/lib/auth/auth-gate";
import { useAuth } from "@/lib/auth/use-auth";
import { detectCodeLanguage } from "@/lib/markdown/code-language";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);

function CodeBlock({
  language,
  children,
}: {
  language: string;
  children?: React.ReactNode;
}) {
  const code = String(children).replace(/\n$/, "");

  return (
    <SyntaxHighlighter language={language} style={oneDark}>
      {code}
    </SyntaxHighlighter>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("读取图片失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function formatCompactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function summarizeUsages(usages?: ModelUsageEventData[]) {
  if (!usages?.length) return null;
  const total = usages.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      cacheHitTokens: sum.cacheHitTokens + usage.cacheHitTokens,
      cacheMissTokens: sum.cacheMissTokens + usage.cacheMissTokens,
      cacheCreationTokens:
        sum.cacheCreationTokens + usage.cacheCreationTokens,
      estimatedCostCny: sum.estimatedCostCny + usage.estimatedCostCny,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostCny: 0,
    },
  );
  const measuredInput = total.cacheHitTokens + total.cacheMissTokens;
  return {
    ...total,
    cacheHitRate:
      measuredInput > 0 ? total.cacheHitTokens / measuredInput : 0,
  };
}

function MessageUsageBar({ usages }: { usages?: ModelUsageEventData[] }) {
  const usage = summarizeUsages(usages);
  if (!usage) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-700/70 pt-2 text-[11px] text-slate-500">
      <span title="真实总 tokens">
        token {formatCompactNumber(usage.totalTokens)}
      </span>
      <span title="输入 tokens">
        输入 {formatCompactNumber(usage.inputTokens)}
      </span>
      <span title="输出 tokens">
        输出 {formatCompactNumber(usage.outputTokens)}
      </span>
      {(usage.cacheHitTokens > 0 || usage.cacheMissTokens > 0) && (
        <span title="DeepSeek prompt cache 命中率">
          缓存命中 {(usage.cacheHitRate * 100).toFixed(1)}%
        </span>
      )}
      {usage.cacheCreationTokens > 0 && (
        <span title="缓存创建 tokens">
          缓存创建 {formatCompactNumber(usage.cacheCreationTokens)}
        </span>
      )}
      <span title="按模型价格估算的本次费用">
        约 ¥{usage.estimatedCostCny.toFixed(4)}
      </span>
    </div>
  );
}

function ReasoningPanel({
  reasoning,
  streaming,
}: {
  reasoning?: ReasoningEventData[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    if (streaming && reasoning?.length) setOpen(true);
  }, [streaming, reasoning?.length]);

  if (!reasoning?.length) return null;
  const content = [...reasoning]
    .sort((left, right) => left.modelCallIndex - right.modelCallIndex)
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
  if (!content) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-violet-800/60 bg-violet-950/20">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "收起思考过程" : "展开思考过程"}
        title={open ? "收起思考过程" : "展开思考过程"}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-violet-200 hover:bg-violet-900/20"
      >
        <span className="flex items-center gap-2 font-medium">
          <span>{streaming ? "正在思考" : "thinking"}</span>
          {streaming && (
            <span aria-hidden="true" className="flex items-center gap-1">
              <span className="h-1 w-1 animate-bounce rounded-full bg-violet-300 [animation-delay:-0.3s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-violet-300 [animation-delay:-0.15s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-violet-300" />
            </span>
          )}
        </span>
        <svg
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-violet-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="max-h-80 overflow-y-auto border-t border-violet-800/40 px-3 py-2 text-xs leading-6 text-slate-400">
          <MessageMarkdown content={content} />
          {streaming && <span className="ml-1 inline-block animate-pulse text-violet-300">●</span>}
        </div>
      )}
    </div>
  );
}

function PlanProgress({
  plan,
  steps,
  disabled,
  onRecover,
}: {
  plan?: ExecutionPlanData;
  steps?: PlanProgressEventData[];
  disabled: boolean;
  onRecover: (control: PlanExecutionControlData) => void;
}) {
  if (!steps?.length) return null;
  const statusClass = {
    pending: "text-slate-400",
    running: "text-cyan-300",
    completed: "text-emerald-300",
    failed: "text-rose-300",
    skipped: "text-slate-500",
  } as const;
  const statusLabel = {
    pending: "等待",
    running: "执行中",
    completed: "已完成",
    failed: "未完成",
    skipped: "已跳过",
  } as const;

  return (
    <div className="mt-3 rounded-lg border border-indigo-800/70 bg-indigo-950/20 px-3 py-2 text-xs">
      <div className="mb-1.5 font-medium text-indigo-200">执行计划</div>
      <div className="space-y-1.5">
        {[...steps].sort((left, right) => left.stepIndex - right.stepIndex).map((step) => (
          <div key={step.stepId} className="flex items-start gap-2">
            <span className="text-slate-500">{step.stepIndex + 1}.</span>
            <div className="min-w-0 flex-1">
              <div className="text-slate-300">{step.goal}</div>
              {step.failureReason && <div className="mt-1 text-rose-300">{step.failureReason}</div>}
              {step.status === "failed" && plan && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onRecover({ startAtStep: step.stepIndex })}
                    className="rounded bg-amber-700 px-2 py-1 text-slate-100 hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-700"
                  >
                    重试此步
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onRecover({
                      startAtStep: Math.min(step.stepIndex + 1, plan.steps.length - 1),
                      skipStepIds: [step.stepId],
                    })}
                    className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                  >
                    跳过此步
                  </button>
                </div>
              )}
            </div>
            <span className={statusClass[step.status]}>{statusLabel[step.status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanReview({
  plan,
  disabled,
  onExecute,
}: {
  plan: ExecutionPlanData;
  disabled: boolean;
  onExecute: (plan: ExecutionPlanData) => void;
}) {
  const [draft, setDraft] = useState<ExecutionPlanData>(() => structuredClone(plan));

  useEffect(() => {
    setDraft(structuredClone(plan));
  }, [plan]);

  const updateStep = (index: number, patch: Partial<ExecutionPlanData["steps"][number]>) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step),
    }));
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-indigo-800/70 bg-indigo-950/20 p-3 text-xs">
      <div className="font-medium text-indigo-200">执行计划</div>
      <label className="block text-slate-400">
        目标
        <input
          value={draft.objective}
          disabled={disabled}
          onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))}
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-200 disabled:opacity-60"
        />
      </label>
      {draft.steps.map((step, index) => (
        <div key={step.id} className="space-y-2 border-t border-indigo-900/70 pt-3">
          <div className="text-slate-400">步骤 {index + 1}</div>
          <textarea
            value={step.goal}
            disabled={disabled}
            onChange={(event) => updateStep(index, { goal: event.target.value })}
            rows={2}
            className="w-full resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-200 disabled:opacity-60"
          />
          <label className="block text-slate-500">
            工具（逗号分隔）
            <input
              value={step.allowedTools.join(", ")}
              disabled={disabled}
              onChange={(event) => updateStep(index, {
                allowedTools: event.target.value.split(",").map((tool) => tool.trim()).filter(Boolean),
              })}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-slate-200 disabled:opacity-60"
            />
          </label>
          <label className="block text-slate-500">
            验收标准（每行一项）
            <textarea
              value={step.successCriteria.join("\n")}
              disabled={disabled}
              onChange={(event) => updateStep(index, {
                successCriteria: event.target.value.split("\n").map((criterion) => criterion.trim()).filter(Boolean),
              })}
              rows={2}
              className="mt-1 w-full resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-200 disabled:opacity-60"
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onExecute(draft)}
        className="rounded bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        确认并执行
      </button>
    </div>
  );
}

function maskEmail(email?: string | null) {
  if (!email) return "未登录";
  const [name, domain] = email.split("@");
  if (!domain) return email;
  if (name.length <= 2) return `${name[0] ?? ""}***@${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

const markdownComponents = {
  h2({ children }: { children?: React.ReactNode }) {
    return <h2 className="mb-2 text-base font-semibold text-white">{children}</h2>;
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
  },
  ol({ children }: { children?: React.ReactNode }) {
    return <ol className="my-2 list-decimal space-y-2 pl-5">{children}</ol>;
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-all text-cyan-300 underline decoration-cyan-500/60 underline-offset-2 hover:text-cyan-200"
      >
        {children}
      </a>
    );
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <table className="my-3 w-full border-collapse overflow-hidden rounded-lg border border-slate-700 text-left text-sm">
        {children}
      </table>
    );
  },
  thead({ children }: { children?: React.ReactNode }) {
    return <thead className="bg-slate-900/80">{children}</thead>;
  },
  tbody({ children }: { children?: React.ReactNode }) {
    return <tbody className="divide-y divide-slate-700">{children}</tbody>;
  },
  tr({ children }: { children?: React.ReactNode }) {
    return <tr className="border-b border-slate-700 last:border-b-0">{children}</tr>;
  },
  th({ children }: { children?: React.ReactNode }) {
    return (
      <th className="border border-slate-700 px-3 py-2 font-semibold text-slate-300">
        {children}
      </th>
    );
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td className="border border-slate-700 px-3 py-2 align-top text-slate-200">{children}</td>;
  },
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const code = String(children);
    const declaredLanguage = className?.replace("language-", "");
    const isBlock = Boolean(declaredLanguage) || code.includes("\n");
    if (!isBlock) {
      return <code className="rounded bg-slate-700 px-1.5 py-0.5 text-sm">{children}</code>;
    }
    return (
      <CodeBlock language={declaredLanguage || detectCodeLanguage(code)}>
        {children}
      </CodeBlock>
    );
  },
};

const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

export default function Home() {
  const { user, supabase } = useAuth();
  const {
    sessions,
    activeId,
    activeSession,
    createSession,
    moveSessionToTop,
    switchSession,
    deleteSession,
    renameSession,
    rerender,
    loading: sessionsLoading,
  } = useChatManager();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [confirmingToolKey, setConfirmingToolKey] = useState<string | null>(null);
  const [sessionDialog, setSessionDialog] = useState<{
    mode: "rename" | "delete";
    sessionId: string;
    title: string;
  } | null>(null);
  const [sessionDialogTitle, setSessionDialogTitle] = useState("");
  const [sessionDialogError, setSessionDialogError] = useState<string | null>(null);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  const [selectedModel, setSelectedModel] =
    useState<ChatModelId>(defaultChatModel);
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  const { messages, loading, streaming, error, contextUsage } = activeSession || {};
  const historyLoading = activeSession?.historyLoading ?? false;
  const lastMessageContent = messages?.length
    ? messages[messages.length - 1]?.content
    : "";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastMessageContent]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [accountMenuOpen]);

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || loading || historyLoading || !activeSession) return;
    const text = input;
    const pendingAttachments = attachments;
    setInput("");
    setAttachments([]);
    setAttachmentError(null);
    moveSessionToTop(activeSession.id);
    requestAnimationFrame(() => inputRef.current?.focus());
    await activeSession.send(text, rerender, {
      webSearchEnabled,
      model: selectedModel,
      attachments: pendingAttachments,
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleImagesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError(null);
    if (attachments.length + files.length > MAX_IMAGE_COUNT) {
      setAttachmentError(`每次最多上传 ${MAX_IMAGE_COUNT} 张图片`);
      return;
    }
    const allowedTypes = new Set<string>(SUPPORTED_IMAGE_MEDIA_TYPES);
    const unsupported = files.find((file) => !allowedTypes.has(file.type));
    if (unsupported) {
      setAttachmentError(`${unsupported.name} 不是支持的 JPEG、PNG、GIF 或 WebP 图片`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_SINGLE_IMAGE_BYTES);
    if (oversized) {
      setAttachmentError(`${oversized.name} 超过 32 MiB`);
      return;
    }
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
      + files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      setAttachmentError("图片总大小不能超过 32 MiB");
      return;
    }
    try {
      const nextAttachments = await Promise.all(files.map(async (file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type as SupportedImageMediaType,
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })));
      setAttachments((current) => [...current, ...nextAttachments]);
      setSelectedModel("deepseek-v4-flash-vision-exp");
    } catch (readError) {
      setAttachmentError(readError instanceof Error ? readError.message : "读取图片失败");
    }
  };

  const handleSelectedModelChange = (model: ChatModelId) => {
    setSelectedModel(model);
    if (attachments.length > 0 && !supportsImageInput(model)) {
      setAttachments([]);
      setAttachmentError("切换到文本模型后，已移除图片附件");
    } else {
      setAttachmentError(null);
    }
  };

  const handleExecutePlan = async (plan: ExecutionPlanData) => {
    if (!activeSession || loading) return;
    moveSessionToTop(activeSession.id);
    await activeSession.send("执行已确认的计划", rerender, {
      webSearchEnabled,
      model: selectedModel,
      approvedPlan: plan,
    });
  };

  const handlePlanRecovery = async (
    plan: ExecutionPlanData,
    steps: PlanProgressEventData[],
    control: PlanExecutionControlData,
  ) => {
    if (!activeSession || loading) return;
    const stepIndex = control.startAtStep ?? 0;
    const priorStepResults = steps
      .filter((step) => step.stepIndex < stepIndex && (step.status === "completed" || step.status === "skipped"))
      .map((step) => ({
        stepId: step.stepId,
        status: step.status as "completed" | "skipped",
        resultSummary: step.resultSummary,
      }));
    if (control.skipStepIds?.length) {
      priorStepResults.push(...control.skipStepIds.map((stepId) => ({
        stepId,
        status: "skipped" as const,
        resultSummary: "用户选择跳过此步骤",
      })));
    }
    moveSessionToTop(activeSession.id);
    await activeSession.send(
      control.skipStepIds?.length ? "跳过失败步骤并继续执行计划" : "重试失败步骤",
      rerender,
      {
        webSearchEnabled,
        model: selectedModel,
        approvedPlan: plan,
        planExecution: { ...control, priorStepResults },
      },
    );
  };

  const handleStop = () => {
    activeSession?.abort();
  };

  const handleSwitchSession = (id: string) => {
    switchSession(id);
    setInput("");
    setAccountMenuOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openSessionDialog = (
    mode: "rename" | "delete",
    session: { id: string; title: string },
  ) => {
    setSessionDialog({ mode, sessionId: session.id, title: session.title });
    setSessionDialogTitle(session.title);
    setSessionDialogError(null);
  };

  const closeSessionDialog = () => {
    if (sessionDialogBusy) return;
    setSessionDialog(null);
    setSessionDialogError(null);
  };

  useEffect(() => {
    if (!sessionDialog) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sessionDialogBusy) {
        setSessionDialog(null);
        setSessionDialogError(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sessionDialog, sessionDialogBusy]);

  const submitSessionDialog = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionDialog || sessionDialogBusy) return;

    setSessionDialogBusy(true);
    setSessionDialogError(null);
    try {
      if (sessionDialog.mode === "rename") {
        await renameSession(sessionDialog.sessionId, sessionDialogTitle);
      } else {
        await deleteSession(sessionDialog.sessionId);
      }
      setSessionDialog(null);
    } catch (dialogError) {
      setSessionDialogError(
        dialogError instanceof Error ? dialogError.message : "操作失败，请重试",
      );
    } finally {
      setSessionDialogBusy(false);
    }
  };

  const handleLoadOlderMessages = async () => {
    if (!activeSession || historyLoading) return;
    const container = messagesScrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const loadingPromise = activeSession.loadOlderMessages();
    rerender();
    await loadingPromise;
    rerender();
    requestAnimationFrame(() => {
      if (container) container.scrollTop += container.scrollHeight - previousHeight;
    });
  };

  const handleSignOut = async () => {
    setAccountMenuOpen(false);
    await supabase.auth.signOut();
  };

  // 加载中状态
  if (sessionsLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950">
        <div className="text-slate-400">加载中...</div>
      </div>
    );
  }

  return (
    <AuthGate>
    <div className="flex h-full bg-slate-950">
      {/* 侧边栏 */}
      <aside
        className={`flex flex-col border-r border-slate-800 bg-slate-900 transition-all duration-300 ${
          sidebarOpen ? "w-64" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        <div className="p-4">
          <button
            onClick={createSession}
            className="w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            + 新对话
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => handleSwitchSession(session.id)}
              className={`group flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm cursor-pointer transition-colors whitespace-nowrap ${
                session.id === activeId
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  session.isRunning ? "bg-emerald-400" : "bg-slate-700"
                }`}
                title={session.isRunning ? "运行中" : "空闲"}
              />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.isRunning && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    session.abort();
                    rerender();
                  }}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-red-300 opacity-80 transition-opacity hover:bg-red-950/50 hover:text-red-200 group-hover:opacity-100"
                  title="停止这个会话"
                >
                  停止
                </button>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openSessionDialog("rename", session);
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 opacity-0 transition-all hover:bg-slate-700/70 hover:text-cyan-300 focus-visible:opacity-100 group-hover:opacity-100"
                title="重命名会话"
                aria-label={`重命名会话“${session.title}”`}
              >
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openSessionDialog("delete", session);
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                title="删除会话"
                aria-label={`删除会话“${session.title}”`}
                disabled={sessions.length <= 1}
              >
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v5M14 11v5" />
                </svg>
              </button>
            </div>
          ))}
        </nav>
        <div ref={accountMenuRef} className="relative border-t border-slate-800 p-3">
          {accountMenuOpen && (
            <div className="absolute bottom-full left-3 mb-2 w-[232px] rounded-2xl border border-slate-700 bg-slate-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur">
              <Link
                href="/knowledge"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15Z" />
                  </svg>
                </span>
                <span>知识库</span>
              </Link>
              <Link
                href="/traces"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 3v18h18" />
                    <path d="M7 15l3-3 3 2 4-6" />
                    <path d="M17 8h3v3" />
                  </svg>
                </span>
                <span>Trace 观测</span>
              </Link>
              <Link
                href="/usage"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2v20" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </span>
                <span>用量统计</span>
              </Link>
              <Link
                href="/schedule"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </span>
                <span>定时任务</span>
              </Link>
              <Link
                href="/settings"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
                  </svg>
                </span>
                <span>系统设置</span>
              </Link>
              <button
                type="button"
                onClick={handleSignOut}
                className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <path d="M16 17l5-5-5-5" />
                    <path d="M21 12H9" />
                  </svg>
                </span>
                <span>退出登录</span>
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setAccountMenuOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-300">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 21a8 8 0 0 0-16 0" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {maskEmail(user?.email)}
            </span>
            <span className="text-lg leading-none text-slate-500">...</span>
          </button>
        </div>
      </aside>

      {/* 主区域 */}
      <main className="flex flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold text-white">知识助手</h1>
        </header>

        <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {activeSession?.hasOlderMessages && (
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={() => void handleLoadOlderMessages()}
                  className="text-xs text-slate-400 hover:text-slate-200 disabled:cursor-wait disabled:text-slate-600"
                >
                  {historyLoading ? "正在加载..." : "加载更早消息"}
                </button>
              </div>
            )}
            {historyLoading && (!messages || messages.length === 0) && (
              <p className="mt-20 text-center text-slate-500">加载会话...</p>
            )}
            {!historyLoading && messages && messages.length === 0 && (
              <p className="mt-20 text-center text-slate-500">
                发送一条消息开始对话
              </p>
            )}
            {messages &&
              messages.map((msg, i) => {
                const isStreaming =
                  streaming &&
                  msg.role === "assistant" &&
                  i === messages.length - 1;
                return (
                  <div
                    key={msg.id ?? `${msg.role}-${msg.createdAt ?? i}`}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "max-w-[78%] bg-cyan-600 text-white"
                        : "w-full bg-slate-800 text-slate-200"
                    } ${isStreaming ? "streaming-msg" : ""}`}
                  >
                    {msg.role === "assistant" && (
                      <ReasoningPanel
                        reasoning={msg.reasoning}
                        streaming={isStreaming}
                      />
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className={`mb-2 grid gap-2 ${msg.attachments.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                        {msg.attachments.map((attachment) => attachment.dataUrl ? (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => setPreviewImage({
                              src: attachment.dataUrl!,
                              alt: attachment.name,
                            })}
                            className="relative h-64 min-w-48 cursor-zoom-in overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                            title={`预览 ${attachment.name}`}
                            aria-label={`预览图片 ${attachment.name}`}
                          >
                            <Image
                              src={attachment.dataUrl}
                              alt={attachment.name}
                              fill
                              unoptimized
                              sizes="(max-width: 768px) 78vw, 640px"
                              className="object-contain transition-transform hover:scale-[1.02]"
                            />
                          </button>
                        ) : (
                          <div
                            key={attachment.id}
                            className="flex min-w-0 items-center gap-2 rounded-md bg-cyan-700/40 px-3 py-2 text-xs text-cyan-50"
                          >
                            <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="truncate">{attachment.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(msg.content || isStreaming) && (
                      <MessageMarkdown
                        content={msg.content || (isStreaming && !msg.reasoning?.length ? "思考中..." : "")}
                      />
                    )}
                    {msg.role === "assistant" && msg.plan && !msg.planSteps?.length && (
                      <PlanReview
                        plan={msg.plan}
                        disabled={Boolean(loading)}
                        onExecute={handleExecutePlan}
                      />
                    )}
                    {msg.role === "assistant" && (
                      <PlanProgress
                        plan={msg.plan}
                        steps={msg.planSteps}
                        disabled={Boolean(loading)}
                        onRecover={(control) => {
                          if (msg.plan && msg.planSteps) {
                            void handlePlanRecovery(msg.plan, msg.planSteps, control);
                          }
                        }}
                      />
                    )}
                    {/* 显示工具调用 */}
                    {msg.role === "assistant" &&
                      msg.toolCalls &&
                      msg.toolCalls.length > 0 && (
                        <div className="mt-3 rounded-lg bg-slate-900/20 px-3 py-2.5">
                          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-slate-400">
                              <span className="text-cyan-400">
                                <svg
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M14.7 6.3a4 4 0 0 0-5-5L7.4 3.6l3 3 2.3-2.3a4 4 0 0 0 2 2Z" />
                                  <path d="m5 12 7 7" />
                                  <path d="m2 15 3-3 7 7-3 3Z" />
                                </svg>
                              </span>
                              <span>工具调用</span>
                              <span className="text-slate-600">·</span>
                              <span className="text-slate-500">{msg.toolCalls.length} 次</span>
                          </div>
                          <div className="space-y-0.5">
                            {msg.toolCalls.map((toolCall, idx) => {
                              const toolStatus = String(toolCall.metadata?.status ?? "");
                              const statusLabel = toolStatus === "awaiting_user_input"
                                ? "等待回答"
                                : toolStatus === "pending_confirmation"
                                  ? "待确认"
                                  : toolStatus === "confirmed"
                                    ? "已执行"
                                    : toolCall.ok
                                      ? "成功"
                                      : "失败";
                              const statusClass = toolStatus === "awaiting_user_input"
                                || toolStatus === "pending_confirmation"
                                ? "text-amber-300"
                                : toolStatus === "confirmed" || toolCall.ok
                                  ? "text-emerald-300"
                                  : "text-rose-300";
                              const dotClass = toolStatus === "awaiting_user_input"
                                || toolStatus === "pending_confirmation"
                                ? "bg-amber-300"
                                : toolStatus === "confirmed" || toolCall.ok
                                  ? "bg-emerald-300"
                                  : "bg-rose-300";

                              return (
                              <div
                                key={idx}
                                className="py-1 text-xs text-slate-300"
                              >
                                <div className="flex min-w-0 items-center gap-2 pl-0.5">
                                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
                                    <span className="truncate font-mono text-[12px] text-slate-300">
                                      {toolCall.name}
                                    </span>
                                  <span className={`shrink-0 text-[10px] ${statusClass}`}>
                                    {statusLabel}
                                  </span>
                                </div>
                                {/* {toolCall.input !== undefined && (
                                  <div>
                                    <span className="text-slate-400">
                                      输入：
                                    </span>
                                    <code className="rounded bg-slate-900/60 px-1.5 py-0.5 font-mono text-cyan-100">
                                      {JSON.stringify(toolCall.input)}
                                    </code>
                                  </div>
                                )} */}
                                {String(toolCall.metadata?.status) === "awaiting_user_input" && (
                                  <div className="ml-3.5 mt-1.5 space-y-1.5 rounded-md bg-slate-800/30 px-3 py-2.5">
                                    <div className="text-slate-400">
                                      {String(toolCall.metadata?.question ?? toolCall.content)}
                                    </div>
                                    {String(toolCall.metadata?.mode) === "single_choice" && (
                                      <div className="text-slate-500">请选择一项，也可以在输入框中补充说明。</div>
                                    )}
                                    {String(toolCall.metadata?.mode) === "confirmation" && (
                                      <div className="text-slate-500">请选择是否继续。</div>
                                    )}
                                    {Array.isArray(toolCall.metadata?.choices) &&
                                      toolCall.metadata.choices
                                        .filter((choice): choice is string => typeof choice === "string")
                                        .map((choice) => (
                                          <button
                                            key={choice}
                                            type="button"
                                            onClick={() => {
                                              setInput(choice);
                                              requestAnimationFrame(() => inputRef.current?.focus());
                                            }}
                                            className="mr-1.5 rounded-md border border-slate-600 bg-slate-700/70 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
                                          >
                                            {choice}
                                          </button>
                                        ))}
                                  </div>
                                )}
                                <div>
                                  {String(toolCall.metadata?.status) ===
                                    "pending_confirmation" && (
                                    <div className="ml-3.5 mt-1.5 flex gap-2">
                                      <button
                                        type="button"
                                        disabled={confirmingToolKey === `${i}:${idx}`}
                                        className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                                        onClick={async () => {
                                          const key = `${i}:${idx}`;
                                          setConfirmingToolKey(key);
                                          try {
                                            await activeSession?.confirmToolCall(
                                              i,
                                              idx,
                                            );
                                            rerender();
                                          } finally {
                                            setConfirmingToolKey(null);
                                          }
                                        }}
                                      >
                                        {confirmingToolKey === `${i}:${idx}`
                                          ? "执行中..."
                                          : "确认执行"}
                                      </button>
                                      <button
                                        onClick={async () => {
                                          if (confirmingToolKey) return;
                                          await activeSession?.cancelToolCall(
                                            i,
                                            idx,
                                          );
                                          rerender();
                                        }}
                                        type="button"
                                        className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600"
                                      >
                                        取消
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    {/* 显示引用来源 */}
                    {msg.role === "assistant" &&
                      msg.sources &&
                      msg.sources.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-700">
                          <div className="text-xs text-slate-400 mb-2">
                            📚 参考来源
                          </div>
                          <div className="space-y-1.5">
                            {msg.sources.map((source, idx) => (
                              <a
                                key={idx}
                                href={source.pageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                              >
                                <span className="font-medium hover:underline">
                                  [{idx + 1}] {source.title}
                                </span>
                                <span className="text-slate-500 ml-1">
                                  (相似度:{" "}
                                  {(source.similarity * 100).toFixed(0)}%)
                                </span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    {msg.role === "assistant" && (
                      <MessageUsageBar usages={msg.modelUsages} />
                    )}
                  </div>
                  </div>
                );
              })}
            <div ref={messagesEndRef} />
            {error && (
              <div className="flex justify-start">
                <div className="w-full rounded-2xl bg-red-900/30 px-4 py-3 text-sm text-red-400">
                  {error}
                </div>
              </div>
            )}
          </div>
        </div>

        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          webSearchEnabled={webSearchEnabled}
          onWebSearchEnabledChange={setWebSearchEnabled}
          contextUsage={contextUsage}
          selectedModel={selectedModel}
          onSelectedModelChange={handleSelectedModelChange}
          attachments={attachments}
          attachmentError={attachmentError}
          onImagesSelected={(files) => void handleImagesSelected(files)}
          onRemoveAttachment={(id) => {
            setAttachments((current) => current.filter((attachment) => attachment.id !== id));
            setAttachmentError(null);
          }}
          onSend={handleSend}
          onStop={handleStop}
          isRunning={Boolean(loading || streaming || historyLoading)}
          disabled={!input.trim() && attachments.length === 0}
        />
        <ImagePreviewDialog
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      </main>
      {sessionDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSessionDialog();
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-dialog-title"
            aria-describedby="session-dialog-description"
            onSubmit={submitSessionDialog}
            className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-2xl shadow-black/50"
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  sessionDialog.mode === "delete"
                    ? "bg-rose-500/10 text-rose-300"
                    : "bg-cyan-500/10 text-cyan-300"
                }`}
              >
                {sessionDialog.mode === "delete" ? (
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="session-dialog-title" className="text-base font-semibold text-slate-100">
                  {sessionDialog.mode === "delete" ? "删除会话" : "重命名会话"}
                </h2>
                <p id="session-dialog-description" className="mt-1 text-sm leading-6 text-slate-400">
                  {sessionDialog.mode === "delete"
                    ? "删除后将无法恢复，该会话的消息和本地工具结果也会一并清理。"
                    : "输入一个清晰的名称，方便之后快速找到这个会话。"}
                </p>
              </div>
            </div>

            {sessionDialog.mode === "rename" ? (
              <div className="mt-5">
                <label htmlFor="session-title" className="mb-2 block text-xs font-medium text-slate-400">
                  会话名称
                </label>
                <input
                  id="session-title"
                  autoFocus
                  maxLength={60}
                  value={sessionDialogTitle}
                  onChange={(event) => setSessionDialogTitle(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-500/70 focus:ring-2 focus:ring-cyan-500/10"
                />
                <div className="mt-1.5 text-right text-[11px] text-slate-600">
                  {sessionDialogTitle.trim().length}/60
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-xl bg-slate-950/60 px-3.5 py-3 text-sm text-slate-300">
                <span className="block text-xs text-slate-500">即将删除</span>
                <span className="mt-1 block truncate font-medium">{sessionDialog.title}</span>
              </div>
            )}

            {sessionDialogError && (
              <div className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {sessionDialogError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={sessionDialogBusy}
                onClick={closeSessionDialog}
                className="rounded-lg px-3.5 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={sessionDialogBusy || (sessionDialog.mode === "rename" && !sessionDialogTitle.trim())}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  sessionDialog.mode === "delete"
                    ? "bg-rose-600 hover:bg-rose-500"
                    : "bg-cyan-600 hover:bg-cyan-500"
                }`}
              >
                {sessionDialogBusy
                  ? "处理中..."
                  : sessionDialog.mode === "delete"
                    ? "确认删除"
                    : "保存名称"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
    </AuthGate>
  );
}
