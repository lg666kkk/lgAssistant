"use client";

import { forwardRef, useEffect, useId, useRef, useState, type ForwardedRef } from "react";
import { type InstalledSkill, matchSlashCommands, skillSlashQuery, searchInstalledSkills } from "../model/slash-commands";
import { useInstalledSkills } from "../hooks/use-installed-skills";
import * as Tooltip from "@radix-ui/react-tooltip";
import Image from "next/image";
import { type ChatModelId } from "@/lib/agent/models";
import type { ComposerImageAttachment } from "@/lib/chat/image-storage";
import { AlertCircle, Box, ImagePlus, LoaderCircle, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import type { ContextUsageEventData } from "@repo/contracts";
import type { PendingChatRequest } from "../model/chat-session";
import { ImagePreviewDialog, type PreviewImage } from "./image-preview-dialog";
import { ModelPicker } from "./model-picker";
import { SiteFooter } from "@web/layout/site-footer";
import type { UserLlmModel } from "@/lib/llm/types";

type ChatInputProps = {
  userId?: string;
  value: string;
  selectedSkill?: InstalledSkill | null;
  onSelectSkill: (skill: InstalledSkill) => void;
  onRemoveSkill: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  webSearchEnabled: boolean;
  contextUsage?: ContextUsageEventData | null;
  contextError?: string | null;
  commandStatus?: string | null;
  commandBusy?: boolean;
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
  onCompact: () => void;
  onStop: () => void;
  pendingRequests?: PendingChatRequest[];
  onRemovePendingRequest?: (id: string) => void;
  onPrioritizePendingRequest?: (id: string) => void;
  onEditPendingRequest?: (id: string) => void;
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
      userId,
      value,
      selectedSkill,
      onSelectSkill,
      onRemoveSkill,
      disabled = false,
      isRunning = false,
      webSearchEnabled,
      contextUsage,
      contextError,
      commandStatus,
      commandBusy = false,
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
      onCompact,
      onStop,
      pendingRequests = [],
      onRemovePendingRequest,
      onPrioritizePendingRequest,
      onEditPendingRequest,
    },
    ref,
  ) {
    const inputRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
    const commandMenuId = useId();
    const [commandIndex, setCommandIndex] = useState(0);
    const [commandsDismissed, setCommandsDismissed] = useState(false);
    const skillQuery = skillSlashQuery(value);
    const catalog = useInstalledSkills(userId, skillQuery !== null);
    const matches = searchInstalledSkills(catalog.items, skillQuery ?? "");
    const commands = matchSlashCommands(value);
    const menuOpen = !commandsDismissed && skillQuery !== null;
    const menuItems = [...commands.map((command) => ({
      key: command.name, ...command, disabled: commandBusy || isRunning, value: command.name, skill: undefined,
    })), ...matches.map((item) => ({
      key: `skill:${item.id}`, name: `/${item.name}`, label: "Skill",
      description: item.description, disabled: !item.enabled, value: "", skill: item,
    }))];
    const activeCommandIndex = Math.min(commandIndex, Math.max(0, menuItems.length - 1));
    useEffect(() => {
      setCommandIndex(0);
      setCommandsDismissed(false);
    }, [value]);
    useEffect(() => {
      if (menuOpen) document.getElementById(`${commandMenuId}-${activeCommandIndex}`)?.scrollIntoView({ block: "nearest" });
    }, [activeCommandIndex, commandMenuId, menuOpen]);
    const selectCommand = (item: typeof menuItems[number]) => {
      if (item.skill) {
        onSelectSkill(item.skill);
        onChange("");
      } else {
        onCompact();
      }
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    };

    const removeSkillAtCaret = () => {
      const el = inputRef.current;
      const selection = window.getSelection();
      if (!selectedSkill || !el || !selection?.isCollapsed || !selection.rangeCount) return false;
      const caret = selection.getRangeAt(0);
      if (!el.contains(caret.startContainer)) return false;
      const beforeCaret = caret.cloneRange();
      beforeCaret.selectNodeContents(el);
      beforeCaret.setEnd(caret.startContainer, caret.startOffset);
      if (beforeCaret.toString().length !== 0) return false;
      onRemoveSkill();
      return true;
    };

    useEffect(() => {
      const el = inputRef.current;
      if (!el || !selectedSkill) return;
      const handleBeforeInput = (event: InputEvent) => {
        if (!event.isComposing && event.inputType === "deleteContentBackward" && removeSkillAtCaret()) {
          event.preventDefault();
        }
      };
      el.addEventListener("beforeinput", handleBeforeInput);
      return () => el.removeEventListener("beforeinput", handleBeforeInput);
    }, [selectedSkill, onRemoveSkill]);

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
    const breakdownItems = contextUsage?.breakdown
      ? contextBreakdownLabels
          .map(([key, label]) => ({ key, label, tokens: contextUsage.breakdown![key] }))
          .filter((item) => item.tokens > 0)
      : [];

    return (
      <div className="shrink-0 bg-slate-950 px-4 pb-3 pt-3">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-[18px] border border-slate-700/60 bg-slate-900 transition-colors focus-within:border-cyan-500/70">
            {pendingRequests.length > 0 && (
              <div className="border-b border-slate-800">
                {pendingRequests.map((request, index) => (
                  <div key={request.id} className="flex min-h-12 items-center gap-3 border-b border-slate-800 px-4 py-2.5 last:border-b-0">
                    <span className="w-4 shrink-0 text-center text-xs tabular-nums text-slate-500" aria-label={`排队第 ${index + 1} 条`}>{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200" title={request.content}>
                      {request.content || "图片问题"}
                    </span>
                    <button
                      type="button"
                      onClick={() => onPrioritizePendingRequest?.(request.id)}
                      disabled={index === 0}
                      className="shrink-0 text-sm text-slate-400 transition hover:text-cyan-300 disabled:cursor-default disabled:text-slate-600"
                      title={index === 0 ? "已提交，将在当前回答结束后执行" : "提交为下一条执行，不中断当前回答"}
                    >
                      提交
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemovePendingRequest?.(request.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                      title="移除排队问题"
                      aria-label="移除排队问题"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditPendingRequest?.(request.id)}
                      disabled={attachmentsUploading || !onEditPendingRequest}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-800 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
                      title="移回输入框编辑，覆盖当前内容"
                      aria-label={`编辑第 ${index + 1} 条排队消息`}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative px-3.5 py-3">
              {commandStatus && <div role="status" aria-live="polite" className="mb-2 flex items-center gap-2 text-sm text-slate-300">
                {commandBusy && <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {commandStatus}
              </div>}
              {menuOpen && (
                <div id={commandMenuId} role="listbox" aria-label="斜杠命令与已安装 Skill" className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-xl">
                  <div role="presentation" className="px-3 py-2 text-xs text-slate-400">
                    {!userId ? "登录后查看已安装的 Skill" : catalog.loading ? "正在读取已安装 Skill…" : `已安装 Skill · ${matches.length} 个匹配`}
                    {catalog.error && <div className="mt-1 text-amber-300">{catalog.error}，关闭命令后重新打开可重试</div>}
                    {userId && !catalog.loading && !catalog.error && menuItems.length === 0 && <div className="mt-1">没有匹配结果，试试 Skill 名称或描述</div>}
                  </div>
                  {menuItems.map((command, index) => (
                    <button
                      key={command.key}
                      id={`${commandMenuId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeCommandIndex}
                      aria-disabled={command.disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { if (!command.disabled) selectCommand(command); }}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${index === activeCommandIndex ? "bg-slate-800 text-cyan-200" : "text-slate-300 hover:bg-slate-800"}`}
                    >
                      <span className="w-1/3 shrink-0 break-words font-mono text-sm">{command.name}</span>
                      <span className="min-w-0"><span className="block text-sm font-medium">{command.label}{command.disabled && <span className="ml-2 text-xs text-slate-500">未启用</span>}</span><span className="line-clamp-2 text-xs text-slate-400">{command.description}</span></span>
                    </button>
                  ))}
                </div>
              )}
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
              <div className="flex min-h-[72px] flex-wrap items-start gap-2">
                {selectedSkill && (
                  <span className="mt-1 inline-flex max-w-full shrink-0 items-center gap-1 rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-xs font-medium leading-5 text-cyan-300" aria-label={`已选择 Skill：${selectedSkill.name}`}>
                    <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{selectedSkill.name}</span>
                  </span>
                )}
              <div
                ref={(node) => {
                  inputRef.current = node;
                  setForwardedRef(ref, node);
                }}
                role="textbox"
                aria-label="消息内容"
                aria-multiline="true"
                aria-controls={menuOpen ? commandMenuId : undefined}
                aria-expanded={menuOpen}
                aria-haspopup="listbox"
                aria-activedescendant={menuOpen && menuItems.length ? `${commandMenuId}-${activeCommandIndex}` : undefined}
                contentEditable
                suppressContentEditableWarning
                data-placeholder={selectedSkill ? "输入任务内容" : "给个人知识助手发送消息，输入 / 查看命令"}
                onInput={(e) => onChange(e.currentTarget.innerText)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Backspace" && removeSkillAtCaret()) {
                    e.preventDefault();
                    return;
                  }
                  if (menuOpen && !e.shiftKey) {
                    if (menuItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                      e.preventDefault();
                      setCommandIndex((activeCommandIndex + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setCommandsDismissed(true);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      const item = menuItems[activeCommandIndex];
                      if (item && !item.disabled) selectCommand(item);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                className={`max-h-48 min-h-[72px] min-w-[8rem] flex-1 overflow-y-auto whitespace-pre-wrap break-words text-base leading-6 text-slate-100 outline-none empty:before:text-slate-500 empty:before:content-[attr(data-placeholder)] sm:text-sm sm:leading-6 ${selectedSkill ? "py-1" : ""}`}
              />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onWebSearchEnabledChange(!webSearchEnabled)}
                    aria-pressed={webSearchEnabled}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${
                      webSearchEnabled
                        ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
                        : "border-slate-700 bg-slate-800/70 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      className="h-3.5 w-3.5"
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
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip.Provider delayDuration={120}>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          type="button"
                          className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                          aria-label={
                            contextUsage
                              ? `当前上下文已用 ${contextPercent}%`
                              : "正在估算当前上下文"
                          }
                          style={{
                            background: contextUsage
                              ? `conic-gradient(${contextColor} ${contextPercent}%, #334155 ${contextPercent}% 100%)`
                              : "#334155",
                          }}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full bg-slate-900"
                            aria-hidden="true"
                          />
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
                                  <span>{isRunning ? "本次调用上下文" : "下次请求上下文预估"}</span>
                                  <span>{contextPercent}%</span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                                  <div className="h-full rounded-full" style={{ width: `${contextPercent}%`, backgroundColor: contextColor }} />
                                </div>
                                <div>
                                  预计 ~{formatTokens(contextUsage.estimatedTokens)} / {formatTokens(contextUsage.workingWindowTokens)}
                                </div>
                                <div className="text-slate-400">
                                  可增加输入 ~{formatTokens(contextUsage.availableInputTokens ?? contextUsage.remainingTokens)} · 配置窗口 {formatTokens(contextUsage.modelWindowTokens)}
                                </div>
                                {contextUsage.outputReserveTokens !== undefined && (
                                  <div className="text-slate-400">
                                    输出预留 {formatTokens(contextUsage.outputReserveTokens)} · 安全余量 {formatTokens(contextUsage.safetyMarginTokens ?? 0)}
                                  </div>
                                )}
                                {contextUsage.compacted && <div className="text-slate-400">已压缩发送上下文，原始聊天记录保留</div>}
                                {contextUsage.canFit === false && <div className="text-amber-300">压缩后仍超出容量，请缩短输入或选择更大窗口的模型</div>}
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

                            </div>
                          ) : (
                            <span>{contextError ?? "正在重新估算上下文…"}</span>
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
                    className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                    title={attachmentsUploading ? "正在上传图片" : "添加图片"}
                    aria-label={attachmentsUploading ? "正在上传图片" : "添加图片"}
                  >
                    {attachmentsUploading ? (
                      <LoaderCircle className="h-[18px] w-[18px] animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <ImagePlus className="h-[18px] w-[18px]" aria-hidden="true" />
                    )}
                  </button>
                  {isRunning ? (
                    <button
                      type="button"
                      onClick={onStop}
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-400 sm:h-8 sm:w-8"
                      title="停止当前回答"
                      aria-label="停止当前回答"
                    >
                      <span className="h-2.5 w-2.5 rounded-sm bg-white" />
                    </button>
                  ) : (
                  <button
                    type="button"
                    onClick={onSend}
                    disabled={disabled}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500 text-white transition-colors hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 sm:h-8 sm:w-8"
                    title="发送"
                    aria-label="发送"
                  >
                    <svg
                      aria-hidden="true"
                      width="23"
                      height="23"
                      className="h-4 w-4"
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
          </div>
          <SiteFooter className="mt-2" showDisclaimer />
          <ImagePreviewDialog
            image={previewImage}
            onClose={() => setPreviewImage(null)}
          />
        </div>
      </div>
    );
  },
);
