"use client";

import { forwardRef, useEffect, useRef, useState, type ForwardedRef } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import Image from "next/image";
import { type ChatModelId } from "@/lib/agent/models";
import type { ComposerImageAttachment } from "@/lib/chat/image-storage";
import { AlertCircle, ImagePlus, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ContextUsageEventData } from "@repo/contracts";
import { ImagePreviewDialog, type PreviewImage } from "./image-preview-dialog";
import { ModelPicker } from "./model-picker";
import type { UserLlmModel } from "@/lib/llm/types";

type ChatInputProps = {
  value: string;
  disabled?: boolean;
  isRunning?: boolean;
  webSearchEnabled: boolean;
  contextUsage?: ContextUsageEventData | null;
  selectedModel: ChatModelId;
  models: UserLlmModel[];
  modelsLoading?: boolean;
  attachments: ComposerImageAttachment[];
  attachmentsUploading?: boolean;
  attachmentError?: string | null;
  onChange: (value: string) => void;
  onWebSearchEnabledChange: (enabled: boolean) => void;
  onSelectedModelChange: (model: ChatModelId) => void;
  onImagesSelected: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onBeforeImageSelect?: () => boolean;
  onSend: () => void;
  onStop: () => void;
};

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }

  if (ref) {
    ref.current = value;
  }
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatExactTokens(value: number) {
  return Math.round(value).toLocaleString("zh-CN");
}

const contextBreakdownLabels: Array<[
  keyof NonNullable<ContextUsageEventData["breakdown"]>,
  string,
]> = [
  ["conversationTokens", "对话与历史"],
  ["systemTokens", "系统指令"],
  ["userProfileTokens", "用户画像"],
  ["memoryTokens", "记忆"],
  ["retrievalPolicyTokens", "检索策略"],
  ["knowledgeRagTokens", "知识库 RAG"],
  ["webRetrievalTokens", "Web 检索"],
  ["toolSchemaTokens", "工具定义"],
  ["toolCallTokens", "工具调用协议"],
  ["toolResultTokens", "其他工具结果"],
  ["otherTokens", "结构与其他"],
];

export const ChatInput = forwardRef<HTMLDivElement, ChatInputProps>(
  function ChatInput(
    {
      value,
      disabled = false,
      isRunning = false,
      webSearchEnabled,
      contextUsage,
      selectedModel,
      models,
      modelsLoading = false,
      attachments,
      attachmentsUploading = false,
      attachmentError,
      onChange,
      onWebSearchEnabledChange,
      onSelectedModelChange,
      onImagesSelected,
      onRemoveAttachment,
      onRetryAttachment,
      onBeforeImageSelect,
      onSend,
      onStop,
    },
    ref,
  ) {
    const inputRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

    useEffect(() => {
      const el = inputRef.current;
      if (!el || el.innerText === value) return;
      el.textContent = value;
    }, [value]);

    const contextPercent = contextUsage
      ? Math.min(
          100,
          Math.round(
            (contextUsage.estimatedTokens / contextUsage.workingWindowTokens) * 100,
          ),
        )
      : 0;
    const contextColor =
      contextPercent >= 90
        ? "#f87171"
        : contextPercent >= 75
          ? "#fbbf24"
          : "#22d3ee";
    const runBudgetPercent = contextUsage?.runBudget
      ? Math.min(
          100,
          Math.round(
            contextUsage.runBudget.spentTokens
            / contextUsage.runBudget.maxTokens
            * 100,
          ),
        )
      : 0;
    const runBudgetColor = runBudgetPercent >= 90
      ? "#f87171"
      : runBudgetPercent >= 75 ? "#fbbf24" : "#22d3ee";
    const breakdownItems = contextUsage?.breakdown
      ? contextBreakdownLabels
          .map(([key, label]) => ({ key, label, tokens: contextUsage.breakdown![key] }))
          .filter((item) => item.tokens > 0)
      : [];

    return (
      <div className="border-t border-slate-800 bg-slate-950 px-4 py-5">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-[28px] border border-slate-700/80 bg-slate-900 px-5 py-4 shadow-2xl shadow-black/30 transition-colors focus-within:border-cyan-500/70">
            {attachments.length > 0 && (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-slate-700 bg-slate-950"
                  >
                    {attachment.uploadStatus === "ready" && attachment.previewUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreviewImage({
                          src: attachment.previewUrl!,
                          alt: attachment.name,
                        })}
                        className="relative block h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400"
                        title={`预览 ${attachment.name}`}
                        aria-label={`预览图片 ${attachment.name}`}
                      >
                        <Image
                          src={attachment.previewUrl}
                          alt={attachment.name}
                          fill
                          unoptimized
                          sizes="80px"
                          className="object-cover transition-transform group-hover:scale-105"
                        />
                      </button>
                    ) : attachment.uploadStatus === "uploading" ? (
                      <div
                        className="flex h-full flex-col items-center justify-center gap-1.5 bg-slate-900 text-slate-400"
                        role="status"
                        aria-label={`${attachment.name} 正在上传`}
                      >
                        <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        <span className="max-w-full truncate px-2 text-[10px]">上传中</span>
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-1 bg-rose-950/40 px-2 text-rose-300">
                        <AlertCircle className="h-5 w-5" aria-hidden="true" />
                        <span className="text-[10px]">上传失败</span>
                        <button
                          type="button"
                          onClick={() => onRetryAttachment(attachment.id)}
                          className="absolute bottom-1 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/90 text-slate-200 hover:bg-cyan-600 hover:text-white"
                          title={`重试上传 ${attachment.name}`}
                          aria-label={`重试上传 ${attachment.name}`}
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(attachment.id)}
                      disabled={attachment.uploadStatus === "uploading"}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/85 text-slate-200 opacity-80 hover:bg-rose-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
                      title={`移除 ${attachment.name}`}
                      aria-label={`移除图片 ${attachment.name}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              ref={(node) => {
                inputRef.current = node;
                setForwardedRef(ref, node);
              }}
              role="textbox"
              aria-multiline="true"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="给个人知识助手发送消息"
              onInput={(e) => onChange(e.currentTarget.innerText)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              className="max-h-40 min-h-[88px] overflow-y-auto whitespace-pre-wrap px-1 text-base leading-7 text-slate-100 outline-none empty:before:text-slate-500 empty:before:content-[attr(data-placeholder)]"
            />
            <div className="mt-4 flex items-center justify-between gap-2 sm:gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={() => onWebSearchEnabledChange(!webSearchEnabled)}
                  aria-pressed={webSearchEnabled}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors sm:h-9 sm:gap-2 sm:px-3.5 sm:text-sm ${
                    webSearchEnabled
                      ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
                      : "border-slate-700 bg-slate-800/70 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
                  }`}
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
                    className="h-4 w-4 sm:h-[18px] sm:w-[18px]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20" />
                    <path d="M12 2a15.3 15.3 0 0 1 0 20" />
                    <path d="M12 2a15.3 15.3 0 0 0 0 20" />
                  </svg>
                  联网搜索
                </button>
                <ModelPicker
                  selectedModel={selectedModel}
                  models={models}
                  loading={modelsLoading}
                  onSelectedModelChange={onSelectedModelChange}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
                <Tooltip.Provider delayDuration={120}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                        aria-label={
                          contextUsage
                            ? `当前上下文已用 ${contextPercent}%${contextUsage.runBudget ? `，本轮 Agent 预算已用 ${runBudgetPercent}%` : ""}`
                            : "正在估算当前上下文"
                        }
                        style={{
                          background: contextUsage
                            ? `conic-gradient(${contextColor} ${contextPercent}%, #334155 ${contextPercent}% 100%)`
                            : "#334155",
                        }}
                      >
                        <span
                          className="h-3 w-3 rounded-full bg-slate-900"
                          aria-hidden="true"
                        />
                        {contextUsage?.runBudget && (
                          <span
                            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-slate-900"
                            style={{ backgroundColor: runBudgetColor }}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="top"
                        sideOffset={10}
                        className="z-50 w-80 rounded-md border border-slate-700 bg-slate-900 px-3 py-3 text-xs text-slate-200 shadow-xl shadow-black/40"
                      >
                        {contextUsage ? (
                          <div className="space-y-3">
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-3 font-medium text-slate-100">
                                <span>当前工作上下文</span>
                                <span>{contextPercent}%</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                                <div className="h-full rounded-full" style={{ width: `${contextPercent}%`, backgroundColor: contextColor }} />
                              </div>
                              <div>
                                预计 ~{formatTokens(contextUsage.estimatedTokens)} / {formatTokens(contextUsage.workingWindowTokens)}
                              </div>
                              <div className="text-slate-400">
                                剩余 ~{formatTokens(contextUsage.remainingTokens)} · 模型上限 {formatTokens(contextUsage.modelWindowTokens)}
                              </div>
                            </div>

                            {breakdownItems.length > 0 && (
                              <div className="border-t border-slate-700/70 pt-2">
                                <div className="mb-1.5 font-medium text-slate-300">上下文构成（估算）</div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                  {breakdownItems.map((item) => (
                                    <div key={item.key} className="flex min-w-0 items-center justify-between gap-2">
                                      <span className="truncate text-slate-400">{item.label}</span>
                                      <span className="shrink-0 font-mono text-slate-200">{formatExactTokens(item.tokens)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {contextUsage.runBudget && (
                              <div className="border-t border-slate-700/70 pt-2">
                                <div className="flex items-center justify-between gap-3 font-medium text-slate-300">
                                  <span>本轮 Agent 累计预算</span>
                                  <span style={{ color: runBudgetColor }}>{runBudgetPercent}%</span>
                                </div>
                                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-700">
                                  <div className="h-full rounded-full" style={{ width: `${runBudgetPercent}%`, backgroundColor: runBudgetColor }} />
                                </div>
                                <div className="mt-1.5">
                                  已用 {formatTokens(contextUsage.runBudget.spentTokens)} / {formatTokens(contextUsage.runBudget.maxTokens)}
                                </div>
                                <div className="text-slate-400">
                                  下次输入 ~{formatTokens(contextUsage.runBudget.nextRequestTokens)} + 输出预留 {formatTokens(contextUsage.runBudget.outputReserveTokens)}
                                </div>
                                {!contextUsage.runBudget.canContinue && (
                                  <div className="mt-1 rounded bg-rose-950/50 px-2 py-1 text-rose-300">
                                    剩余 {formatTokens(contextUsage.runBudget.remainingTokens)}，不足以承担下一次调用
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span>正在估算当前上下文…</span>
                        )}
                        <Tooltip.Arrow className="fill-slate-900" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    onImagesSelected(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (onBeforeImageSelect && !onBeforeImageSelect()) return;
                    fileInputRef.current?.click();
                  }}
                  disabled={attachmentsUploading}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 sm:h-10 sm:w-10"
                  title={attachmentsUploading ? "正在上传图片" : "添加图片"}
                  aria-label={attachmentsUploading ? "正在上传图片" : "添加图片"}
                >
                  {attachmentsUploading ? (
                    <LoaderCircle className="h-[18px] w-[18px] animate-spin motion-reduce:animate-none sm:h-[22px] sm:w-[22px]" aria-hidden="true" />
                  ) : (
                    <ImagePlus className="h-[18px] w-[18px] sm:h-[22px] sm:w-[22px]" aria-hidden="true" />
                  )}
                </button>
                {isRunning ? (
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-400 sm:h-11 sm:w-11"
                    title="停止"
                  >
                    <span className="h-3 w-3 rounded-sm bg-white sm:h-3.5 sm:w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onSend}
                    disabled={disabled}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500 text-white transition-colors hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 sm:h-11 sm:w-11"
                    title="发送"
                  >
                    <svg
                      aria-hidden="true"
                      width="23"
                      height="23"
                      className="h-[19px] w-[19px] sm:h-[23px] sm:w-[23px]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 19V5" />
                      <path d="m5 12 7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {attachmentError && (
              <p className="mt-2 px-1 text-xs text-rose-300">{attachmentError}</p>
            )}
          </div>
          <ImagePreviewDialog
            image={previewImage}
            onClose={() => setPreviewImage(null)}
          />
        </div>
      </div>
    );
  },
);
