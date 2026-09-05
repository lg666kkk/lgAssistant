"use client";
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useChatManager } from "@web/features/chat/hooks/use-chat-manager";
import { useContextPreview } from "@web/features/chat/hooks/use-context-preview";
import { useLlmCatalog } from "@web/features/connections/hooks/use-llm-catalog";
import { ChatInput } from "@web/features/chat/components/chat-input";
import { ChatThread } from "@web/features/chat/components/chat-thread";
import { ImagePreviewDialog, type PreviewImage } from "@web/features/chat/components/image-preview-dialog";
import { SessionDialog, type SessionDialogState } from "@web/features/chat/components/session-dialog";
import {
  AppSidebar,
  getConnectionTabLabel,
  getCustomAgentTabLabel,
  type ConnectionTabId,
  type CustomAgentTabId,
  type PrimaryCapability,
} from "@web/layout/app-sidebar";
import { LanguageModelCenter } from "@web/features/connections/components/language-model-center";
import { EmbeddingCenter } from "@web/features/connections/components/embedding-center";
import { SearchEngineCenter } from "@web/features/connections/components/search-engine-center";
import { LangfuseCenter } from "@web/features/observability/components/langfuse-center";
import { MemoryCenter } from "@web/features/memory/components/memory-center";
import { UserProfileCenter } from "@web/features/memory/components/user-profile-center";
import { KnowledgeCenter } from "@web/features/knowledge/components/knowledge-center";
import { TraceCenter } from "@web/features/observability/components/trace-center";
import { ScheduleCenter } from "@web/features/schedule/components/schedule-center";
import { SkillCenter } from "@web/features/skills/components/skill-center";
import type {
  ChatModelId,
  ExecutionPlanData,
  PlanExecutionControlData,
  PlanProgressEventData,
} from "@repo/contracts";
import {
  MAX_IMAGE_COUNT,
  MAX_SINGLE_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  type ChatImageAttachment,
  type SupportedImageMediaType,
} from "@/lib/agent/multimodal";
import {
  buildChatImageStoragePath,
  deleteChatImages,
  createChatImageSignedUrlMap,
  uploadChatImage,
  type ComposerImageAttachment,
} from "@/lib/chat/image-storage";
import { AuthGate } from "@web/lib/auth/auth-gate";
import { useAuth } from "@web/lib/auth/use-auth";
import { createUuid } from "@/lib/platform/uuid";

const UsageCenter = dynamic(
  () => import("@web/features/usage/components/usage-center").then((module) => module.UsageCenter),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-950 text-sm text-slate-500">
        加载用量统计...
      </div>
    ),
  },
);

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

export default function Home() {
  const { user, supabase } = useAuth();
  const {
    catalog: llmCatalog,
    loading: llmCatalogLoading,
    error: llmCatalogError,
    reload: reloadLlmCatalog,
  } = useLlmCatalog(Boolean(user));
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
  const [activeCapability, setActiveCapability] = useState<PrimaryCapability>("chat");
  const [activeConnectionTab, setActiveConnectionTab] =
    useState<ConnectionTabId>("language-model");
  const [activeCustomAgentTab, setActiveCustomAgentTab] =
    useState<CustomAgentTabId>("english");
  const [requestedTraceId, setRequestedTraceId] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState | null>(null);
  const [selectedModel, setSelectedModel] = useState<ChatModelId>("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const sessionScrollPositionsRef = useRef(new Map<string, number>());
  const inputRef = useRef<HTMLDivElement>(null);

  const { loading, streaming, contextUsage } = activeSession || {};
  const isAgentRunning = Boolean(loading || streaming);
  const previewContextUsage = useContextPreview({
    enabled: Boolean(
      user
      && activeSession
      && selectedModel
      && activeCapability === "chat"
    ),
    sessionId: activeSession?.id,
    modelId: selectedModel,
    webSearchEnabled,
    draftText: input,
    imageCount: attachments.length,
    isRunning: isAgentRunning,
  });
  const historyLoading = activeSession?.historyLoading ?? false;
  const historyLoaded = activeSession?.historyLoaded ?? false;
  const attachmentsUploading = attachments.some(
    (attachment) => attachment.uploadStatus === "uploading",
  );
  const attachmentsReady = attachments.every(
    (attachment) => attachment.uploadStatus === "ready",
  );
  const configuredModels = useMemo(
    () => (llmCatalog?.models ?? []).filter((model) => model.enabled),
    [llmCatalog?.models],
  );
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
    }
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const panel = params.get("panel");
    if (panel !== "knowledge" && panel !== "traces" && panel !== "search-engine" && panel !== "embedding" && panel !== "usage" && panel !== "skills" && panel !== "schedule" && panel !== "langfuse" && panel !== "user-profile") return;
    setActiveCapability("connections");
    setActiveConnectionTab(panel);
    setRequestedTraceId(panel === "traces" ? params.get("traceId") : null);
  }, []);
  const mainTitle = activeCapability === "chat"
    ? activeSession?.title ?? "新对话"
    : activeCapability === "connections"
      ? getConnectionTabLabel(activeConnectionTab)
      : getCustomAgentTabLabel(activeCustomAgentTab);

  useLayoutEffect(() => {
    if (activeCapability !== "chat" || !activeId || !historyLoaded) return;
    const container = messagesScrollRef.current;
    if (!container) return;

    const savedPosition = sessionScrollPositionsRef.current.get(activeId);
    const nextPosition = savedPosition ?? container.scrollHeight;
    container.scrollTop = nextPosition;
    sessionScrollPositionsRef.current.set(activeId, container.scrollTop);
  }, [activeCapability, activeId, historyLoaded]);

  useEffect(() => {
    if (llmCatalogLoading) return;
    if (configuredModels.some((model) => model.id === selectedModel)) return;
    const preferred = configuredModels.find((model) =>
      model.id === llmCatalog?.preferences.defaultModelId) ?? configuredModels[0];
    setSelectedModel(preferred?.id ?? "");
  }, [configuredModels, llmCatalog?.preferences.defaultModelId, llmCatalogLoading, selectedModel]);

  const handleSend = async () => {
    if (
      (!input.trim() && attachments.length === 0)
      || loading
      || historyLoading
      || attachmentsUploading
      || !activeSession
      || !user
      || !selectedModel
    ) return;
    const text = input;
    if (!attachmentsReady) {
      setAttachmentError("请等待图片上传完成，或移除上传失败的图片");
      return;
    }
    const pendingAttachments: ChatImageAttachment[] = attachments.map((attachment) => {
      const {
        file: _file,
        uploadStatus: _uploadStatus,
        uploadError: _uploadError,
        ...readyAttachment
      } = attachment;
      return readyAttachment;
    });

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

  const uploadComposerAttachment = async (attachment: ComposerImageAttachment) => {
    if (!user || !activeSession) return;
    setAttachments((current) => current.map((candidate) =>
      candidate.id === attachment.id
        ? { ...candidate, uploadStatus: "uploading", uploadError: undefined }
        : candidate));
    setAttachmentError(null);

    try {
      const [dataUrl, storagePath] = await Promise.all([
        readFileAsDataUrl(attachment.file),
        uploadChatImage(supabase, {
          userId: user.id,
          sessionId: activeSession.id,
          imageId: attachment.id,
          mediaType: attachment.mediaType,
          file: attachment.file,
        }),
      ]);
      const signedUrls = await createChatImageSignedUrlMap(supabase, {
        userId: user.id,
        sessionId: activeSession.id,
        paths: [storagePath],
      });
      const previewUrl = signedUrls.get(storagePath);
      if (!previewUrl) throw new Error(`无法加载图片 ${attachment.name} 的远端预览`);

      setAttachments((current) => current.map((candidate) =>
        candidate.id === attachment.id
          ? {
              ...candidate,
              dataUrl,
              storagePath,
              previewUrl,
              uploadStatus: "ready",
              uploadError: undefined,
            }
          : candidate));
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "上传图片失败";
      setAttachments((current) => current.map((candidate) =>
        candidate.id === attachment.id
          ? { ...candidate, uploadStatus: "error", uploadError: message }
          : candidate));
      setAttachmentError(message);
    }
  };

  const handleImagesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError(null);
    if (!user || !activeSession) {
      setAttachmentError("请先登录并选择会话");
      return;
    }
    const visionModel = configuredModels.find((model) =>
      model.id === llmCatalog?.preferences.visionModelId && model.supportsImages)
      ?? configuredModels.find((model) => model.supportsImages);
    if (!visionModel) {
      setAttachmentError("请先在连接 > 大语言模型中配置视觉模型");
      return;
    }
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
      setAttachmentError(
        `${oversized.name} 超过 ${MAX_SINGLE_IMAGE_BYTES / 1024 / 1024} MiB`,
      );
      return;
    }
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
      + files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      setAttachmentError("图片总大小不能超过 32 MiB");
      return;
    }
    const nextAttachments = files.map((file) => {
      const id = createUuid();
      const mediaType = file.type as SupportedImageMediaType;
      return {
        id,
        name: file.name,
        mediaType,
        size: file.size,
        file,
        storagePath: buildChatImageStoragePath({
          userId: user.id,
          sessionId: activeSession.id,
          imageId: id,
          mediaType,
        }),
        uploadStatus: "uploading" as const,
      };
    });
    setAttachments((current) => [...current, ...nextAttachments]);
    setSelectedModel(visionModel.id);
    await Promise.allSettled(nextAttachments.map(uploadComposerAttachment));
  };

  const handleRemoveAttachment = async (id: string) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    setAttachments((current) => current.filter((candidate) => candidate.id !== id));
    setAttachmentError(null);
    if (attachment?.storagePath) {
      await deleteChatImages(supabase, [attachment.storagePath]).catch((cleanupError) => {
        console.error("清理已移除图片失败:", cleanupError);
        setAttachmentError("图片已移除，但远端文件清理失败");
      });
    }
  };

  const handleRetryAttachment = async (id: string) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (!attachment || attachment.uploadStatus === "uploading") return;
    await uploadComposerAttachment(attachment);
  };

  const handleSelectedModelChange = async (model: ChatModelId) => {
    if (attachmentsUploading) {
      setAttachmentError("图片正在处理中，请稍候");
      return;
    }
    const selectedOption = configuredModels.find((candidate) => candidate.id === model);
    if (attachments.length > 0 && !selectedOption?.supportsImages) {
      try {
        await clearPendingAttachments();
      } catch (cleanupError) {
        setAttachmentError(
          cleanupError instanceof Error ? cleanupError.message : "清理待发送图片失败",
        );
        return;
      }
      setAttachmentError("切换到文本模型后，已移除图片附件");
    }
    setSelectedModel(model);
    if (attachments.length === 0) setAttachmentError(null);
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

  const clearPendingAttachments = async () => {
    const storagePaths = attachments.flatMap((attachment) =>
      attachment.storagePath ? [attachment.storagePath] : []);
    if (storagePaths.length > 0) {
      await deleteChatImages(supabase, storagePaths);
    }
    setAttachments([]);
  };

  const handleCreateSession = async () => {
    if (attachmentsUploading) {
      setAttachmentError("图片正在处理中，请稍候");
      return;
    }
    try {
      await clearPendingAttachments();
    } catch (cleanupError) {
      setAttachmentError(
        cleanupError instanceof Error ? cleanupError.message : "清理待发送图片失败",
      );
      return;
    }
    setAttachmentError(null);
    createSession();
    setInput("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSwitchSession = async (id: string) => {
    if (attachmentsUploading) {
      setAttachmentError("图片正在处理中，请稍候");
      return;
    }
    try {
      await clearPendingAttachments();
    } catch (cleanupError) {
      setAttachmentError(
        cleanupError instanceof Error ? cleanupError.message : "清理待发送图片失败",
      );
      return;
    }
    switchSession(id);
    setInput("");
    setAttachmentError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openSessionDialog = (
    mode: "rename" | "delete",
    session: { id: string; title: string },
  ) => {
    setSessionDialog({ mode, sessionId: session.id, title: session.title });
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (attachmentsUploading && sessionId === activeId) {
      throw new Error("图片正在处理中，请稍候");
    }
    if (sessionId === activeId) await clearPendingAttachments();
    await deleteSession(sessionId);
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
    if (attachmentsUploading) {
      setAttachmentError("图片正在处理中，请稍候");
      return;
    }
    try {
      await clearPendingAttachments();
      await supabase.auth.signOut();
    } catch (signOutError) {
      setAttachmentError(signOutError instanceof Error ? signOutError.message : "退出前清理图片失败");
    }
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
      <AppSidebar
        open={sidebarOpen}
        activeCapability={activeCapability}
        activeConnectionTab={activeConnectionTab}
        activeCustomAgentTab={activeCustomAgentTab}
        sessions={sessions}
        activeSessionId={activeId}
        userEmail={user?.email}
        onCapabilityChange={setActiveCapability}
        onConnectionTabChange={setActiveConnectionTab}
        onCustomAgentTabChange={setActiveCustomAgentTab}
        onCreateSession={() => void handleCreateSession()}
        onSwitchSession={(id) => void handleSwitchSession(id)}
        onStopSession={(session) => {
          session.abort();
          rerender();
        }}
        onOpenSessionDialog={openSessionDialog}
        onSignOut={() => void handleSignOut()}
      />

      {/* 主区域 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="shrink-0 text-slate-400 transition-colors hover:text-white"
            aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
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
          <h1
            className="min-w-0 truncate text-lg font-semibold text-white"
            title={mainTitle}
          >
            {mainTitle}
          </h1>
        </header>

        {activeCapability === "chat" ? (
          <>
            <ChatThread
              session={activeSession}
              scrollRef={messagesScrollRef}
              onScrollPositionChange={(position) => {
                if (activeId) sessionScrollPositionsRef.current.set(activeId, position);
              }}
              onLoadOlderMessages={() => void handleLoadOlderMessages()}
              onPreviewImage={setPreviewImage}
              onInputSuggestion={(value) => {
                setInput(value);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onExecutePlan={(plan) => void handleExecutePlan(plan)}
              onPlanRecovery={(plan, steps, control) => {
                void handlePlanRecovery(plan, steps, control);
              }}
              onSessionUpdate={rerender}
            />
            <ChatInput
              ref={inputRef}
              value={input}
              onChange={setInput}
              webSearchEnabled={webSearchEnabled}
              onWebSearchEnabledChange={setWebSearchEnabled}
              contextUsage={isAgentRunning
                ? contextUsage
                : previewContextUsage ?? contextUsage}
              selectedModel={selectedModel}
              models={configuredModels}
              modelsLoading={llmCatalogLoading}
              onSelectedModelChange={handleSelectedModelChange}
              attachments={attachments}
              attachmentsUploading={attachmentsUploading}
              attachmentError={attachmentError}
              onImagesSelected={(files) => void handleImagesSelected(files)}
              onRemoveAttachment={(id) => void handleRemoveAttachment(id)}
              onRetryAttachment={(id) => void handleRetryAttachment(id)}
              onSend={handleSend}
              onStop={handleStop}
              isRunning={Boolean(isAgentRunning || historyLoading)}
              disabled={
                attachmentsUploading
                || !attachmentsReady
                || !selectedModel
                || (!input.trim() && attachments.length === 0)
              }
            />
            <ImagePreviewDialog
              image={previewImage}
              onClose={() => setPreviewImage(null)}
            />
          </>
        ) : activeCapability === "connections" && activeConnectionTab === "language-model" ? (
          <LanguageModelCenter
            catalog={llmCatalog}
            loading={llmCatalogLoading}
            error={llmCatalogError}
            onRefresh={reloadLlmCatalog}
          />
        ) : activeCapability === "connections" && activeConnectionTab === "search-engine" ? (
          <SearchEngineCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "embedding" ? (
          <EmbeddingCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "usage" ? (
          <UsageCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "knowledge" ? (
          <KnowledgeCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "skills" ? (
          <SkillCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "schedule" ? (
          <ScheduleCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "traces" ? (
          <TraceCenter initialTraceId={requestedTraceId} />
        ) : activeCapability === "connections" && activeConnectionTab === "langfuse" ? (
          <LangfuseCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "memory-list" ? (
          <MemoryCenter />
        ) : activeCapability === "connections" && activeConnectionTab === "user-profile" ? (
          <UserProfileCenter />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-slate-950 text-sm text-slate-600" aria-label={`${mainTitle}内容区域`}>
            {mainTitle}配置将在后续接入
          </div>
        )}
      </main>
      {sessionDialog && (
        <SessionDialog
          dialog={sessionDialog}
          onClose={() => setSessionDialog(null)}
          onRename={renameSession}
          onDelete={handleDeleteSession}
        />
      )}
    </div>
    </AuthGate>
  );
}
