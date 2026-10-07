"use client";

import { useEffect, useState, type RefObject } from "react";
import Image from "next/image";
import { BookOpen, Image as ImageIcon, ScanLine, Wrench } from "lucide-react";
import type {
  ExecutionPlanData,
  PlanExecutionControlData,
  PlanProgressEventData,
} from "@repo/contracts";
import type { ChatSession } from "@web/features/chat/model/chat-session";
import { AskUserCard, readUserQuestions } from "./ask-user-card";
import { ThinkingIndicator } from "./thinking-indicator";
import { ScheduledJobCard } from "./scheduled-job-card";
import { summarizeToolCalls } from "@web/features/chat/model/tool-call-summary";
import { getMcpCallPresentation, McpToolCallDetails } from "./mcp-tool-call";
import { getChatImagePreviewUrl } from "@/lib/chat/image-storage";
import type { PreviewImage } from "./image-preview-dialog";
import {
  MessageMarkdown,
  MessageUsageBar,
  PlanProgress,
  PlanReview,
  ReasoningPanel,
} from "./message-content";

type ChatThreadProps = {
  session?: ChatSession;
  scrollRef: RefObject<HTMLDivElement>;
  onScrollPositionChange: (position: number) => void;
  onLoadOlderMessages: () => void;
  onPreviewImage: (image: PreviewImage) => void;
  onInputSuggestion: (value: string) => void;
  onExecutePlan: (plan: ExecutionPlanData) => void;
  onPlanRecovery: (
    plan: ExecutionPlanData,
    steps: PlanProgressEventData[],
    control: PlanExecutionControlData,
  ) => void;
  onSessionUpdate: () => void;
};

export function ChatThread({
  session,
  scrollRef,
  onScrollPositionChange,
  onLoadOlderMessages,
  onPreviewImage,
  onExecutePlan,
  onPlanRecovery,
  onSessionUpdate,
}: ChatThreadProps) {
  const [confirmingToolKey, setConfirmingToolKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestStartedAt = session?.requestStartedAt ?? session?.compactionStartedAt ?? null;

  // Keep the active request duration live without adding a timer to every message.
  useEffect(() => {
    if (requestStartedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [requestStartedAt]);
  const messages = session?.messages;
  const loading = session?.loading;
  const streaming = session?.streaming;
  const historyLoading = session?.historyLoading ?? false;
  useEffect(() => {
    if (messages?.[messages.length - 1]?.command !== "compact") return;
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages?.length, session?.compacting, scrollRef]);

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => onScrollPositionChange(event.currentTarget.scrollTop)}
      className="flex-1 overflow-y-auto px-4 py-6"
    >
      <div className="mx-auto max-w-4xl space-y-4">
        {session?.hasOlderMessages && (
          <div className="flex justify-center">
            <button
              type="button"
              disabled={historyLoading}
              onClick={onLoadOlderMessages}
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
          <p className="mt-20 text-center text-slate-500">发送一条消息开始对话</p>
        )}
        {messages?.map((message, messageIndex) => {
          if (message.command === "compact") {
            const running = message.commandState === "running";
            return message.role === "user" ? (
              <div key={message.id ?? `compact-user-${messageIndex}`} className="flex justify-end">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/10 px-3 py-1.5 text-sm font-medium text-cyan-300">
                  <ScanLine className="h-4 w-4" aria-hidden="true" />压缩上下文
                </span>
              </div>
            ) : (
              <div key={message.id ?? `compact-result-${messageIndex}`} role="status" aria-live="polite" className="px-4 py-3 text-sm text-slate-400">
                <div className="pb-3 text-xs text-slate-500">{running ? "处理中" : "已处理"} {formatElapsed(message.durationMs ?? Math.max(0, now - (session?.compactionStartedAt ?? now)))}</div>
                <div className={`flex items-start gap-2 border-t border-slate-800 pt-3 ${message.commandState === "failed" ? "text-rose-400" : ""}`}>
                  <ScanLine className={`mt-0.5 h-4 w-4 shrink-0 ${running ? "animate-pulse motion-reduce:animate-none" : ""}`} aria-hidden="true" />
                  <span>{running ? "正在压缩上下文" : message.content}</span>
                </div>
              </div>
            );
          }
          const isStreaming = Boolean(
            streaming
            && message.role === "assistant"
            && (session?.streamingMessage ? message === session.streamingMessage : messageIndex === messages.length - 1),
          );
          const toolCallSummary = summarizeToolCalls(message.toolCalls ?? []);
          const isThinkingOnly = isStreaming
            && !message.content
            && !message.reasoning?.length
            && !message.toolCalls?.length
            && !message.attachments?.length
            && !message.sources?.length
            && !message.plan;
          return (
            <div
              key={message.id ?? `${message.role}-${message.createdAt ?? messageIndex}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={
                  message.role === "user"
                    ? "flex max-w-[78%] flex-col items-end gap-2"
                    : isThinkingOnly
                      ? "w-fit px-3 py-2"
                      : `w-full rounded-2xl bg-slate-800 px-4 py-3 text-sm leading-relaxed text-slate-200 ${isStreaming ? "streaming-msg" : ""}`
                }
              >
                {message.role === "assistant" && (
                  <ReasoningPanel reasoning={message.reasoning} streaming={isStreaming} />
                )}
                {message.attachments && message.attachments.length > 0 && (
                  <div
                    className={
                      message.attachments.length > 1
                        ? "flex max-w-[22rem] flex-wrap justify-end gap-2"
                        : "h-20 w-20"
                    }
                  >
                    {message.attachments.map((attachment) => {
                      const previewUrl = getChatImagePreviewUrl(attachment);
                      return previewUrl ? (
                        <button
                          key={attachment.id}
                          type="button"
                          onClick={() => onPreviewImage({ src: previewUrl, alt: attachment.name })}
                          className="group relative block h-20 w-20 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-slate-700/80 bg-slate-900 shadow-lg shadow-black/20 transition hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                          title={`预览 ${attachment.name}`}
                          aria-label={`预览图片 ${attachment.name}`}
                        >
                          <Image
                            src={previewUrl}
                            alt={attachment.name}
                            fill
                            unoptimized
                            sizes="80px"
                            className="object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/65 px-3 py-1.5 text-left text-[11px] text-white/80 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                            {attachment.name}
                          </span>
                        </button>
                      ) : (
                        <div
                          key={attachment.id}
                          className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 p-2 text-[10px] text-slate-300"
                        >
                          <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="truncate">{attachment.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(message.content || isStreaming) && (
                  message.role === "user" ? (
                    <div className="max-w-full rounded-2xl rounded-tr-md bg-cyan-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm shadow-black/10">
                      <MessageMarkdown content={message.content} />
                    </div>
                  ) : !message.content && isStreaming && !message.reasoning?.length ? (
                    <ThinkingIndicator />
                  ) : (
                    <MessageMarkdown content={message.content || ""} />
                  )
                )}
                {message.role === "assistant" && message.plan && !message.planSteps?.length && (
                  <PlanReview
                    plan={message.plan}
                    disabled={Boolean(loading)}
                    onExecute={onExecutePlan}
                  />
                )}
                {message.role === "assistant" && (
                  <PlanProgress
                    plan={message.plan}
                    steps={message.planSteps}
                    disabled={Boolean(loading)}
                    onRecover={(control) => {
                      if (message.plan && message.planSteps) {
                        onPlanRecovery(message.plan, message.planSteps, control);
                      }
                    }}
                  />
                )}
                {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
                  <div className="mt-3 rounded-lg bg-slate-900/20 px-3 py-2.5">
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-slate-400">
                      <Wrench className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                      <span>工具调用</span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-500">请求 {toolCallSummary.requestedCount} 次</span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-500">实际执行 {toolCallSummary.executedCount} 次</span>
                      {toolCallSummary.skippedCount > 0 && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className="text-amber-300">跳过 {toolCallSummary.skippedCount} 次</span>
                        </>
                      )}
                      {toolCallSummary.waitingCount > 0 && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className="text-amber-300">等待 {toolCallSummary.waitingCount} 次</span>
                        </>
                      )}
                      {toolCallSummary.blockedCount > 0 && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className="text-rose-300">未执行 {toolCallSummary.blockedCount} 次</span>
                        </>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {message.toolCalls.map((toolCall, toolIndex) => {
                        const toolStatus = String(toolCall.metadata?.status ?? "");
                        const skipped = toolStatus === "retrieval_budget_skipped";
                        const pending = skipped || toolStatus === "awaiting_user_input" || toolStatus === "pending_confirmation";
                        const succeeded = !skipped && (toolStatus === "confirmed" || toolCall.ok);
                        const statusLabel = skipped
                          ? "已跳过"
                          : toolStatus === "awaiting_user_input"
                          ? "等待回答"
                          : toolStatus === "pending_confirmation"
                            ? "待确认"
                            : toolStatus === "confirmed"
                              ? "已执行"
                              : toolCall.ok ? "成功" : "失败";
                        const statusClass = pending
                          ? "text-amber-300"
                          : succeeded ? "text-emerald-300" : "text-rose-300";
                        const dotClass = pending
                          ? "bg-amber-300"
                          : succeeded ? "bg-emerald-300" : "bg-rose-300";
                        const toolKey = `${messageIndex}:${toolIndex}`;
                        const terminalInput = toolCall.input ?? (toolCall.metadata?.toolCall as { input?: unknown } | undefined)?.input;
                        const terminalCommand = typeof (terminalInput as { command?: unknown } | undefined)?.command === "string"
                          ? (terminalInput as { command: string }).command : "";

                        return (
                          <div key={toolKey} className="py-1 text-xs text-slate-300">
                            <div className="flex min-w-0 items-center gap-2 pl-0.5">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
                              <span className="min-w-0 break-words text-[12px] text-slate-300">{getMcpCallPresentation(toolCall)?.label ?? toolCall.name}</span>
                              <span className={`shrink-0 text-[10px] ${statusClass}`}>{statusLabel}</span>
                            </div>
                            <McpToolCallDetails tool={toolCall} />
                            {toolCall.name === "create_scheduled_job" && toolStatus === "pending_confirmation" && (
                              <ScheduledJobCard input={terminalInput} />
                            )}
                            {toolCall.name === "run_terminal_command" && toolStatus === "pending_confirmation" && (
                              <div className="ml-3.5 mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
                                <p className="mb-1 text-[11px] text-amber-200">将在联网沙盒中执行，文件在本聊天中暂存约 30 分钟</p>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-200">{terminalCommand || "未保存命令参数"}</pre>
                              </div>
                            )}
                            {toolCall.name === "view_skill" && toolCall.ok && (
                              <StandardSkillCard content={toolCall.content} />
                            )}
                            {(toolStatus === "awaiting_user_input" || toolStatus === "answered") && (
                              <AskUserCard questions={readUserQuestions(toolCall.metadata)} disabled={Boolean(loading)} submitted={typeof toolCall.metadata?.answer === "string" ? toolCall.metadata.answer : undefined} onSubmit={async answer => {
                                await session?.confirmToolCall(messageIndex, toolIndex, onSessionUpdate, "answer", answer);
                                if (session?.error) throw new Error(session.error);
                              }} />
                            )}
                            {toolStatus === "pending_confirmation" && (
                              <div className="ml-3.5 mt-1.5 flex gap-2">
                                <button
                                  type="button"
                                  disabled={Boolean(confirmingToolKey) || Boolean(loading) || (toolCall.name === "run_terminal_command" && !terminalCommand)}
                                  className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                                  onClick={async () => {
                                    setConfirmingToolKey(toolKey);
                                    try {
                                      await session?.confirmToolCall(messageIndex, toolIndex, onSessionUpdate);
                                      onSessionUpdate();
                                    } finally {
                                      setConfirmingToolKey(null);
                                    }
                                  }}
                                >
                                  {confirmingToolKey === toolKey ? "执行中..." : toolCall.name === "create_scheduled_job" ? "确认创建" : "确认执行"}
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(confirmingToolKey) || Boolean(loading)}
                                  onClick={async () => {
                                    await session?.cancelToolCall(messageIndex, toolIndex, onSessionUpdate);
                                    onSessionUpdate();
                                  }}
                                  className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                                >
                                  取消
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {message.role === "assistant" && message.sources && message.sources.length > 0 && (
                  <div className="mt-3 border-t border-slate-700 pt-3">
                    <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
                      <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>参考来源</span>
                    </div>
                    <div className="space-y-1.5">
                      {message.sources.map((source, sourceIndex) => (
                        <a
                          key={`${source.pageUrl}-${sourceIndex}`}
                          href={source.pageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs text-cyan-400 transition-colors hover:text-cyan-300"
                        >
                          <span className="font-medium hover:underline">[{sourceIndex + 1}] {source.title}</span>
                          <span className="ml-1 text-slate-500">(相似度: {(source.similarity * 100).toFixed(0)}%)</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {message.role === "assistant" && (
                  <MessageUsageBar usages={message.modelUsages}>
                    {!isStreaming && message.durationMs !== undefined && (
                      <span className="whitespace-nowrap">已处理 {formatElapsed(message.durationMs)}</span>
                    )}
                  </MessageUsageBar>
                )}
                {message.role === "assistant" && isStreaming && (
                  <div className="mt-2 border-t border-slate-700/70 pt-2 text-xs text-slate-500">
                    {isStreaming ? "处理中" : "已处理"} {formatElapsed(message.durationMs ?? Math.max(0, now - (requestStartedAt ?? now)))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {session?.error && (
          <div className="flex justify-start">
            <div className="w-full rounded-2xl bg-red-900/30 px-4 py-3 text-sm text-red-400">
              {session.error}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StandardSkillCard({ content }: { content: string }) {
  let skill: { name?: string; description?: string; skillMd?: string; supportFiles?: Record<string, string> };
  try {
    skill = JSON.parse(content) as typeof skill;
  } catch {
    return null;
  }
  if (!skill.skillMd) return null;
  const fileNames = Object.keys(skill.supportFiles ?? {});
  return (
    <details className="ml-3.5 mt-2 overflow-hidden rounded-lg border border-cyan-900/60 bg-slate-950/70" open>
      <summary className="cursor-pointer list-none px-3 py-2.5 text-xs text-cyan-200">
        <span className="font-semibold">Skill：{skill.name ?? "未命名"}</span>
        {skill.description && <span className="ml-2 text-slate-400">{skill.description}</span>}
      </summary>
      <div className="border-t border-cyan-900/40 px-3 py-3">
        <MessageMarkdown content={skill.skillMd} />
        {fileNames.length > 0 && (
          <div className="mt-3 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
            附属文件：{fileNames.join("、")}
          </div>
        )}
      </div>
    </details>
  );
}


function formatElapsed(durationMs: number) {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分 ${seconds}秒`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds} 秒`;
}
