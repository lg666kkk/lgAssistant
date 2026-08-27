"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
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
import remarkGfm from "remark-gfm";
import { Sparkles } from "lucide-react";
import type {
  ExecutionPlanData,
  ModelUsageEventData,
  PlanExecutionControlData,
  PlanProgressEventData,
  ReasoningEventData,
} from "@/lib/agent/runtime/events";
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

function CodeBlock({ language, children }: { language: string; children?: ReactNode }) {
  return (
    <SyntaxHighlighter language={language} style={oneDark}>
      {String(children).replace(/\n$/, "")}
    </SyntaxHighlighter>
  );
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
      cacheCreationTokens: sum.cacheCreationTokens + usage.cacheCreationTokens,
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
    cacheHitRate: measuredInput > 0 ? total.cacheHitTokens / measuredInput : 0,
  };
}

export function MessageUsageBar({ usages }: { usages?: ModelUsageEventData[] }) {
  const usage = summarizeUsages(usages);
  if (!usage) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-700/70 pt-2 text-[11px] text-slate-500">
      <span title="真实总 tokens">token {formatCompactNumber(usage.totalTokens)}</span>
      <span title="输入 tokens">输入 {formatCompactNumber(usage.inputTokens)}</span>
      <span title="输出 tokens">输出 {formatCompactNumber(usage.outputTokens)}</span>
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
      <span title="按模型价格估算的本次费用">约 ¥{usage.estimatedCostCny.toFixed(4)}</span>
    </div>
  );
}

export function ReasoningPanel({
  reasoning,
  streaming,
}: {
  reasoning?: ReasoningEventData[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const wasStreamingRef = useRef(streaming);

  useEffect(() => {
    if (streaming) setOpen(true);
    else if (wasStreamingRef.current) setOpen(false);
    wasStreamingRef.current = streaming;
  }, [streaming]);

  if (!reasoning?.length) return null;
  const entries = [...reasoning]
    .sort((left, right) => left.modelCallIndex - right.modelCallIndex)
    .map((item) => ({ ...item, content: item.content.trim() }))
    .filter((item) => Boolean(item.content));
  if (!entries.length) return null;

  return (
    <div className="mb-3 border-l border-slate-600/70">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "收起思考过程" : "展开思考过程"}
        title={open ? "收起思考过程" : "展开思考过程"}
        onClick={() => setOpen((value) => !value)}
        className="group flex h-8 w-full items-center justify-between text-left text-xs text-slate-400 transition-colors hover:text-slate-200"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className={`h-3.5 w-3.5 shrink-0 ${streaming ? "text-cyan-300" : "text-slate-500"}`} aria-hidden="true" />
          <span className="font-medium text-slate-300">{streaming ? "正在思考" : "思考过程"}</span>
          {streaming ? (
            <span aria-hidden="true" className="flex items-center gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-cyan-300 [animation-delay:-0.3s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-cyan-300 [animation-delay:-0.15s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-cyan-300" />
            </span>
          ) : (
            <span className="text-slate-600">· 已完成</span>
          )}
        </span>
        <svg
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform duration-200 group-hover:text-slate-400 ${open ? "rotate-180" : ""}`}
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
        <div className="max-h-64 overflow-y-auto border-t border-slate-700/50 pb-1 pl-[22px] pr-3 pt-3 text-[13px] leading-6 text-slate-400">
          <div className="space-y-4">
            {entries.map((entry, index) => (
              <section key={`${entry.modelCallIndex}-${index}`}>
                {entries.length > 1 && (
                  <div className="mb-1.5 text-[11px] font-medium text-slate-600">阶段 {index + 1}</div>
                )}
                <ReasoningMarkdown content={entry.content} />
              </section>
            ))}
          </div>
          {streaming && <span className="ml-1 inline-block animate-pulse text-cyan-300">●</span>}
        </div>
      )}
    </div>
  );
}

export function PlanProgress({
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

export function PlanReview({
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

const markdownComponents = {
  h2({ children }: { children?: ReactNode }) {
    return <h2 className="mb-2 text-base font-semibold text-white">{children}</h2>;
  },
  p({ children }: { children?: ReactNode }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }: { children?: ReactNode }) {
    return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
  },
  ol({ children }: { children?: ReactNode }) {
    return <ol className="my-2 list-decimal space-y-2 pl-5">{children}</ol>;
  },
  li({ children }: { children?: ReactNode }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return <a href={href} target="_blank" rel="noreferrer" className="break-all text-cyan-300 underline decoration-cyan-500/60 underline-offset-2 hover:text-cyan-200">{children}</a>;
  },
  table({ children }: { children?: ReactNode }) {
    return <table className="my-3 w-full border-collapse overflow-hidden rounded-lg border border-slate-700 text-left text-sm">{children}</table>;
  },
  thead({ children }: { children?: ReactNode }) {
    return <thead className="bg-slate-900/80">{children}</thead>;
  },
  tbody({ children }: { children?: ReactNode }) {
    return <tbody className="divide-y divide-slate-700">{children}</tbody>;
  },
  tr({ children }: { children?: ReactNode }) {
    return <tr className="border-b border-slate-700 last:border-b-0">{children}</tr>;
  },
  th({ children }: { children?: ReactNode }) {
    return <th className="border border-slate-700 px-3 py-2 font-semibold text-slate-300">{children}</th>;
  },
  td({ children }: { children?: ReactNode }) {
    return <td className="border border-slate-700 px-3 py-2 align-top text-slate-200">{children}</td>;
  },
  code({ className, children }: { className?: string; children?: ReactNode }) {
    const code = String(children);
    const declaredLanguage = className?.replace("language-", "");
    const isBlock = Boolean(declaredLanguage) || code.includes("\n");
    if (!isBlock) return <code className="rounded bg-slate-700 px-1.5 py-0.5 text-sm">{children}</code>;
    return <CodeBlock language={declaredLanguage || detectCodeLanguage(code)}>{children}</CodeBlock>;
  },
};

export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>;
});

const reasoningMarkdownComponents = {
  ...markdownComponents,
  h1({ children }: { children?: ReactNode }) {
    return <h1 className="mb-1.5 mt-3 text-[13px] font-semibold text-slate-300 first:mt-0">{children}</h1>;
  },
  h2({ children }: { children?: ReactNode }) {
    return <h2 className="mb-1.5 mt-3 text-[13px] font-semibold text-slate-300 first:mt-0">{children}</h2>;
  },
  h3({ children }: { children?: ReactNode }) {
    return <h3 className="mb-1.5 mt-3 text-[13px] font-medium text-slate-300 first:mt-0">{children}</h3>;
  },
  p({ children }: { children?: ReactNode }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }: { children?: ReactNode }) {
    return <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>;
  },
  ol({ children }: { children?: ReactNode }) {
    return <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>;
  },
  li({ children }: { children?: ReactNode }) {
    return <li className="pl-0.5 leading-6 marker:text-slate-600">{children}</li>;
  },
  strong({ children }: { children?: ReactNode }) {
    return <strong className="font-semibold text-slate-300">{children}</strong>;
  },
  blockquote({ children }: { children?: ReactNode }) {
    return <blockquote className="my-2 border-l border-slate-700 pl-3 text-slate-500">{children}</blockquote>;
  },
};

const ReasoningMarkdown = memo(function ReasoningMarkdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={reasoningMarkdownComponents}>{content}</ReactMarkdown>;
});
