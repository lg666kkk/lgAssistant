"use client";

import { forwardRef, useEffect, useRef, useState, type ForwardedRef } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import Image from "next/image";
import { type ChatModelId } from "@/lib/agent/models";
import type { ChatImageAttachment } from "@/lib/agent/multimodal";
import { ImagePlus, X } from "lucide-react";
import type { ContextUsageEventData } from "@/lib/agent/runtime/events";
import { ImagePreviewDialog, type PreviewImage } from "./image-preview-dialog";
import { ModelPicker } from "./model-picker";

type ChatInputProps = {
  value: string;
  disabled?: boolean;
  isRunning?: boolean;
  webSearchEnabled: boolean;
  contextUsage?: ContextUsageEventData | null;
  selectedModel: ChatModelId;
  attachments: ChatImageAttachment[];
  attachmentError?: string | null;
  onChange: (value: string) => void;
  onWebSearchEnabledChange: (enabled: boolean) => void;
  onSelectedModelChange: (model: ChatModelId) => void;
  onImagesSelected: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
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

export const ChatInput = forwardRef<HTMLDivElement, ChatInputProps>(
  function ChatInput(
    {
      value,
      disabled = false,
      isRunning = false,
      webSearchEnabled,
      contextUsage,
      selectedModel,
      attachments,
      attachmentError,
      onChange,
      onWebSearchEnabledChange,
      onSelectedModelChange,
      onImagesSelected,
      onRemoveAttachment,
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
                    {attachment.dataUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreviewImage({
                          src: attachment.dataUrl!,
                          alt: attachment.name,
                        })}
                        className="relative block h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400"
                        title={`预览 ${attachment.name}`}
                        aria-label={`预览图片 ${attachment.name}`}
                      >
                        <Image
                          src={attachment.dataUrl}
                          alt={attachment.name}
                          fill
                          unoptimized
                          sizes="80px"
                          className="object-cover transition-transform group-hover:scale-105"
                        />
                      </button>
                    ) : (
                      <span className="flex h-full items-center justify-center px-2 text-center text-[10px] text-slate-400">
                        {attachment.name}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(attachment.id)}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/85 text-slate-200 opacity-80 hover:bg-rose-600 hover:text-white group-hover:opacity-100"
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
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onWebSearchEnabledChange(!webSearchEnabled)}
                  aria-pressed={webSearchEnabled}
                  className={`inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors ${
                    webSearchEnabled
                      ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
                      : "border-slate-700 bg-slate-800/70 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
                  }`}
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
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
                  onSelectedModelChange={onSelectedModelChange}
                />
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Tooltip.Provider delayDuration={120}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                        aria-label={
                          contextUsage
                            ? `上下文窗口已用 ${contextPercent}%`
                            : "上下文窗口将在首轮调用后估算"
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
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="top"
                        sideOffset={10}
                        className="z-50 min-w-52 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 shadow-xl shadow-black/40"
                      >
                        {contextUsage ? (
                          <div className="space-y-1">
                            <div className="font-medium text-slate-100">
                              上下文窗口 {contextPercent}% 已用
                            </div>
                            <div>
                              已用 ~{formatTokens(contextUsage.estimatedTokens)}，总共 {formatTokens(contextUsage.workingWindowTokens)}
                            </div>
                            <div className="text-slate-400">
                              剩余 ~{formatTokens(contextUsage.remainingTokens)} · 模型上限 {formatTokens(contextUsage.modelWindowTokens)}
                            </div>
                          </div>
                        ) : (
                          <span>首轮调用后显示服务端上下文估算</span>
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
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  title="添加图片"
                  aria-label="添加图片"
                >
                  <ImagePlus className="h-[22px] w-[22px]" aria-hidden="true" />
                </button>
                {isRunning ? (
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-400"
                    title="停止"
                  >
                    <span className="h-3.5 w-3.5 rounded-sm bg-white" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onSend}
                    disabled={disabled}
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-cyan-500 text-white transition-colors hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500"
                    title="发送"
                  >
                    <svg
                      aria-hidden="true"
                      width="23"
                      height="23"
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
