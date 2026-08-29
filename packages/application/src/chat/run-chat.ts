import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import {
  ToolSourceType,
  runAgentLoop,
  enqueueSources,
  streamModelResponse,
  forwardTextStream,
} from "@/lib/agent/runtime";
import { enqueueEvent, type PlanProgressEventData } from "@/lib/agent/runtime/events";
import {
  createPlanProposal,
  executePlan,
  normalizeExecutionPlan,
  normalizePlanExecutionControl,
  shouldUsePlanAndExecute,
} from "@/lib/agent/runtime/plan-execution";
import {
  recallForPromptWithStats,
  consolidate,
  handleExplicitForgetRequest,
  renderMemoryOperationContext,
  renderMemoryPrefetchHint,
  type ExplicitForgetResult,
  type MemoryConsolidationOutcome,
} from "@/lib/agent/memory/memory-flow";
import { summarizeMemoryConsolidation } from "@/lib/agent/memory/observability";
import { createEmptyMemoryRerankTrace } from "@/lib/agent/memory/memory-reranker";
import {
  stripInlineImagesForPersistence,
} from "@/lib/agent/multimodal";
import { buildPromptPipe } from "@/lib/agent/prompt/pipe";
import {
  buildRetrievalPlan,
  filterToolsForRetrievalRoute,
  resolveRetrievalAnchor,
} from "@/lib/agent/rag/retrieval-router";
import { sanitizeModelText } from "@/lib/agent/runtime/output-sanitizer";
import { filterToolsForUserIntent } from "@/lib/agent/tools/tool-intent";
import { requiresCitedEvidence } from "@/lib/agent/tools/grounding-policy";
import { renderToolOrchestrationPolicy } from "@/lib/agent/tools/orchestration";
import { redactSensitiveValue } from "@/lib/agent/rag/governance";
import { withSpanLabel } from "@/lib/agent/observability/span-labels";
import { verifyGroundedAnswer } from "@/lib/agent/rag/answer-verifier";
import { mergeEvidenceBundles } from "@/lib/agent/rag/evidence";
import {
  createTrace,
  prependMemoryRecallTraceStep,
  prependUserProfileTraceStep,
  type AgentTrace,
  type MemoryRecallTraceStep,
  type UserProfileTraceStep,
} from "@/lib/agent/runtime/trace";
import {
  retrievalObservationLabel,
  retrievalObservationName,
  summarizeAnswerValidation,
  summarizeRetrievalRoute,
  summarizeRetrieval,
} from "@/lib/agent/observability/agent-trace-summary";
import { buildContextPlan } from "@/lib/agent/context/plan";
import {
  extractLastAssistantText,
} from "./message-utils";
import { buildChatTraceInput } from "./observability";
import { parseChatRequest } from "./request";
import type { ChatApplicationDependencies } from "./ports";

export type RunChatUseCaseInput = {
  request: Request;
  userId: string;
  dependencies: ChatApplicationDependencies;
};

// Application use case: orchestrates one authenticated chat request. The HTTP
// route owns authentication; repository boundaries are introduced in step 3.
export async function runChatUseCase(input: RunChatUseCaseInput) {
  const req = input.request;
  const user = { id: input.userId };
  const deps = input.dependencies;
  const parsedRequest = await parseChatRequest(req, user.id, deps.userContext.resolveModel);
  if (!parsedRequest.ok) return parsedRequest.response;
  const {
    body,
    requestId,
    requestReceivedAt,
    sessionId,
    enableWebSearch,
    selectedRuntimeModel,
    selectedModel,
    requestMessages,
    modelMessages,
    requestTextMessages,
  } = parsedRequest.value;
  let hydratedContext: Awaited<ReturnType<typeof deps.sessions.resolveLoopMessages>> = {
    messages: [...modelMessages],
    source: "client",
    originalMessageCount: modelMessages.length,
    snapshot: null,
  };
  try {
    hydratedContext = await deps.sessions.resolveLoopMessages({
      userId: user.id,
      sessionId,
      messages: modelMessages,
    });
  } catch (error: any) {
    console.error("[session] 读取历史失败，使用请求消息:", error.message);
  }
  const hydratedLoopMessages = hydratedContext.messages;
  const retrievalAnchor = resolveRetrievalAnchor(
    hydratedLoopMessages.flatMap((message) =>
      typeof message.content === "string"
        ? [{ role: message.role, content: message.content }]
        : [],
    ),
    body.approvedPlan !== undefined,
  );
  const approvedPlanObjective = body.approvedPlan
    && typeof body.approvedPlan === "object"
    && !Array.isArray(body.approvedPlan)
    && typeof body.approvedPlan.objective === "string"
      ? body.approvedPlan.objective.trim().slice(0, 500)
      : "";
  const retrievalQuery = retrievalAnchor.foundPriorTask
    ? retrievalAnchor.query
    : approvedPlanObjective || retrievalAnchor.query;
  let knowledgeProfile: string | undefined;
  let knowledgeIndexVersion = "index-unknown";
  try {
    const snapshot = await deps.userContext.readKnowledgeProfile(user.id);
    knowledgeProfile = snapshot?.profile;
    knowledgeIndexVersion = snapshot?.indexVersion ?? knowledgeIndexVersion;
  } catch (error: any) {
    console.error("[knowledge] 读取工具画像快照失败，使用默认描述:", error.message);
  }
  const retrievalPlan = buildRetrievalPlan({
    query: retrievalQuery,
    conversationContext: retrievalAnchor.conversationContext,
    knowledgeProfile,
    indexVersion: knowledgeIndexVersion,
    webEnabled: enableWebSearch,
  });
  const userMemoryConfig = await deps.userContext.resolveMemoryConfig(user.id).catch((error) => {
    console.error("[memory-config] 读取失败，关闭本轮记忆:", error instanceof Error ? error.message : error);
    return null;
  });
  let userProfileLoadError: string | undefined;
  const userProfile = await deps.userContext.resolveUserProfile(user.id).catch((error) => {
    userProfileLoadError = error instanceof Error ? error.message : String(error);
    console.error("[user-profile] 读取失败，本轮不注入:", userProfileLoadError);
    return {
      content: "",
      configured: false,
      revision: 0,
      updatedAt: undefined,
    };
  });
  // 有哪些工具
  const toolRegistry = createBuiltinToolRegistry({ knowledgeProfile, retrievalPlan });
  // 给模型看的工具说明
  // 先在完整 ToolDefinition 上按元数据过滤，再投影成模型 schema。若先调用
  // listForModel，会丢失 outputPolicy/orchestration，路由只能退回硬编码工具名。
  const routeToolDefinitions = filterToolsForRetrievalRoute(
    toolRegistry.list(),
    retrievalPlan.route,
    { webEnabled: enableWebSearch },
  ).filter((tool) => userMemoryConfig?.enabled || !["recall_memory", "search_memory_history"].includes(tool.name));
  const routeTools = toolRegistry.listForModel(routeToolDefinitions);
  const latestUserQuery = [...requestTextMessages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const tools = selectedRuntimeModel.supportsTools
    ? filterToolsForUserIntent(
        routeTools,
        approvedPlanObjective || latestUserQuery,
      )
    : [];
  const approvedPlan = body.approvedPlan === undefined
    ? undefined
    : normalizeExecutionPlan(body.approvedPlan, new Set(tools.map((tool) => tool.name)));
  if (body.approvedPlan !== undefined && !approvedPlan) {
    return new Response(
      JSON.stringify({ error: "确认的计划格式无效，或不包含至少两个有效步骤" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const planExecution = approvedPlan
    ? normalizePlanExecutionControl(body.planExecution, approvedPlan)
    : undefined;
  // 最大工具调用次数
  const maxToolIterations = 8;

  // TextEncoder 将字符串转为字节流（浏览器接收的是字节，不是字符串）
  const encoder = new TextEncoder();

  // 构建 Web 标准的 ReadableStream，将 API 的流式事件转发给浏览器
  const readable = new ReadableStream({
    async start(controller) {
      let closed = false;
      let pendingTrace: AgentTrace | undefined;
      let reportExternalScores: ((trace: AgentTrace) => Promise<void>) | undefined;
      const enqueueText = (text: string) => {
        if (closed || req.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch (error: any) {
          if (error?.code !== "ERR_INVALID_STATE") {
            console.error("[Stream] 写入响应失败:", error);
          }
          closed = true;
          return false;
        }
      };
      const closeStream = () => {
        if (closed) return;
        try {
          controller.close();
        } catch (error: any) {
          if (error?.code !== "ERR_INVALID_STATE") {
            console.error("[Stream] 关闭响应失败:", error);
          }
        } finally {
          closed = true;
        }
      };
      const savePendingTrace = async () => {
        const trace = pendingTrace;
        pendingTrace = undefined;
        if (!trace) return;
        await deps.traces.save(trace, user.id).catch((error: any) =>
          console.error("[trace] 保存失败，跳过:", error.message));
        if (reportExternalScores) {
          // 先落本地审计 trace，再上报 Langfuse Score；评分故障绝不能影响聊天主链路。
          await reportExternalScores(trace).catch((error: any) =>
            console.error("[langfuse] 在线评分失败，跳过:", error.message));
        }
      };

      const traceInput = buildChatTraceInput({
          requestId,
          sessionId,
          userId: user.id,
          model: selectedModel,
          messages: requestTextMessages,
      });
      const safeTraceInput = redactSensitiveValue(traceInput);
      const safeRetrievalPlan = redactSensitiveValue(retrievalPlan);
      const safeUserProfile = redactSensitiveValue({
        configured: userProfile.configured,
        revision: userProfile.revision,
        updatedAt: userProfile.updatedAt,
        contentChars: userProfile.content.length,
        content: userProfile.content,
        loadError: userProfileLoadError,
      });
      const traceDisplayInput = safeTraceInput.query || "(空消息)";
      await deps.telemetry.withTrace({
        userId: user.id,
        name: "agent-chat",
        sessionId,
        traceInput: traceDisplayInput,
        tags: ["api-chat", "agent"],
        metadata: withSpanLabel("agent-chat", {
          requestId,
          sessionId,
          userId: user.id,
          model: selectedModel,
          traceInput: safeTraceInput,
          retrievalPlan: safeRetrievalPlan,
          userProfile: safeUserProfile,
        }),
      }, async ({ trace: langfuseTrace, reportOnlineScores }) => {
        reportExternalScores = reportOnlineScores;
        langfuseTrace.update({
          input: traceDisplayInput,
          metadata: withSpanLabel("agent-chat", {
            requestId,
            sessionId,
            userId: user.id,
            model: selectedModel,
            traceInput: safeTraceInput,
            retrievalPlan: safeRetrievalPlan,
            userProfile: safeUserProfile,
          }),
        });
        langfuseTrace.setTraceIO({ input: traceDisplayInput });
        const projectTraceObservations = (trace: AgentTrace) => {
          for (const step of trace.steps) {
            if (step.type === "retrieval" && step.phase === "graded") {
              const observationName = retrievalObservationName(step);
              const observation = langfuseTrace.startObservation(observationName, {
                metadata: withSpanLabel(observationName, {
                  requestId,
                  planId: step.planId,
                  source: step.source,
                  toolName: step.toolName,
                  spanLabel: retrievalObservationLabel(step),
                }),
              }, { asType: "retriever" });
              observation.update({ output: summarizeRetrieval(step) });
              observation.end();
            } else if (step.type === "answer_validation") {
              const observation = langfuseTrace.startObservation("evidence.validation", {
                metadata: withSpanLabel("evidence.validation", { requestId }),
              }, { asType: "evaluator" });
              observation.update({ output: summarizeAnswerValidation(step) });
              observation.end();
            }
          }
        };

      try {
        const routeObservation = langfuseTrace.startObservation("retrieval.route", {
          metadata: withSpanLabel("retrieval.route", { requestId, planId: retrievalPlan.id }),
        }, { asType: "retriever" });
        routeObservation.update({ output: summarizeRetrievalRoute(retrievalPlan) });
        routeObservation.end();
        // ② 会话记忆：客户端只提交本轮用户消息，历史由服务端恢复。
        let loopMessages = [...hydratedLoopMessages];

        let allToolSources: ToolSourceType[] = [];

        // ① 召回：用最后一条 user 消息当 query，捞出相关记忆，拼成 system 注入
        const lastUser = [...requestMessages]
          .reverse()
          .find((m: any) => m.role === "user");
        let explicitForgetResult: ExplicitForgetResult = { handled: false };
        if (lastUser && userMemoryConfig?.enabled) {
          const observation = langfuseTrace.startObservation("memory.explicit_forget", {
            input: { messageChars: lastUser.content.length },
            metadata: withSpanLabel("memory.explicit_forget", {
              requestId,
              sessionIdPresent: Boolean(sessionId),
            }),
          });
          try {
            explicitForgetResult = await handleExplicitForgetRequest({
              message: lastUser.content,
              userId: user.id,
              sessionId,
              requestId,
            });
            observation.update({
              output: {
                handled: explicitForgetResult.handled,
                status: explicitForgetResult.handled ? explicitForgetResult.status : "not_requested",
                invalidatedCount: explicitForgetResult.handled
                  ? explicitForgetResult.targetKeys.length
                  : 0,
              },
            });
          } catch (error: any) {
            console.error("[memory] 显式忘记处理失败:", error.message);
            observation.update({
              level: "ERROR",
              output: { errorClass: error.name ?? "Error" },
            });
          } finally {
            observation.end();
          }
        }
        const explicitForgetHandled = explicitForgetResult.handled;
        let memorySystem = "";
        let memoryRecallHint = "";
        let memoryRecallTraceStep: Omit<MemoryRecallTraceStep, "index"> | undefined;
        if (lastUser && userMemoryConfig?.enabled) {
          const recallStartedAt = Date.now();
          const observation = langfuseTrace.startObservation("memory.recall", {
            input: {
              query: redactSensitiveValue(lastUser.content),
              queryChars: lastUser.content.length,
            },
            metadata: withSpanLabel("memory.recall", {
              requestId,
              sessionIdPresent: Boolean(sessionId),
            }),
          }, { asType: "retriever" });
          try {
            const recall = await recallForPromptWithStats(lastUser.content, {
              userId: user.id,
              config: userMemoryConfig ?? undefined,
            });
            memorySystem = recall.context;
            memoryRecallHint = renderMemoryPrefetchHint(recall);
            const safeRerankTrace = redactSensitiveValue(recall.rerankTrace);
            memoryRecallTraceStep = {
              type: "memory_recall",
              startedAt: recallStartedAt,
              durationMs: Date.now() - recallStartedAt,
              query: redactSensitiveValue(lastUser.content),
              eligible: recall.eligible,
              candidateCount: recall.candidateCount,
              selectedCount: recall.selectedCount,
              selectedTypes: recall.selectedTypes,
              selectedSources: recall.selectedSources,
              embeddingUsage: recall.embeddingUsage,
              rerank: safeRerankTrace,
            };
            observation.update({
              output: {
                eligible: recall.eligible,
                candidateCount: recall.candidateCount,
                selectedCount: recall.selectedCount,
                injected: Boolean(recall.context),
                injectedChars: recall.context.length,
                selectedTypes: recall.selectedTypes,
                selectedSources: recall.selectedSources,
                embeddingUsage: recall.embeddingUsage,
                rerankUsed: recall.rerankUsed,
                rerankReason: recall.rerankReason,
                rerankMs: recall.rerankMs,
                rerankError: Boolean(recall.rerankError),
                rerank: safeRerankTrace,
              },
            });
          } catch (e: any) {
            console.error("[memory] 召回失败，跳过注入:", e.message);
            // 预取失败不等于「没有记忆」。仍然给出「本轮未预取」这一档提示，
            // 让模型知道可以自己调 recall_memory 补上——否则一次预取异常
            // 会静默退化成整轮裸答。
            memoryRecallHint = renderMemoryPrefetchHint({
              context: "",
              eligible: false,
              candidateCount: 0,
              selectedCount: 0,
              selectedTypes: {},
              selectedSources: {},
              rerankUsed: false,
              rerankReason: "recall_error",
              rerankMs: 0,
              rerankTrace: createEmptyMemoryRerankTrace("recall_error"),
            });
            memoryRecallTraceStep = {
              type: "memory_recall",
              startedAt: recallStartedAt,
              durationMs: Date.now() - recallStartedAt,
              query: redactSensitiveValue(lastUser.content),
              eligible: false,
              candidateCount: 0,
              selectedCount: 0,
              selectedTypes: {},
              selectedSources: {},
              rerank: {
                ...createEmptyMemoryRerankTrace("recall_error"),
                error: redactSensitiveValue(e instanceof Error ? e.message : String(e)),
              },
            };
            observation.update({
              level: "ERROR",
              output: {
                errorClass: e.name ?? "Error",
                rerank: redactSensitiveValue(memoryRecallTraceStep.rerank),
              },
            });
          } finally {
            observation.end();
          }
        }
        const consolidateWithObservation = async (
          conversation: Array<{ role: string; content: unknown }>,
        ) => {
          if (!userMemoryConfig?.enabled) return;
          const startedAt = Date.now();
          // Consolidation stays asynchronous, but its span is created while the root trace is active.
          const observation = langfuseTrace.startObservation("memory.consolidate", {
            input: {
              messageCount: conversation.length,
              userMessageCount: conversation.filter((message) => message.role === "user").length,
            },
            metadata: withSpanLabel("memory.consolidate", {
              requestId,
              sessionIdPresent: Boolean(sessionId),
            }),
          });
          let outcome: MemoryConsolidationOutcome | undefined;
          try {
            const records = await consolidate(conversation, {
              sessionId,
              userId: user.id,
              requestId,
              effectiveAt: requestReceivedAt,
              config: userMemoryConfig,
              onOutcome: (result) => {
                outcome = result;
              },
            });
            const safeOutcome = redactSensitiveValue(outcome ?? {});
            observation.update({
              output: {
                ...safeOutcome,
                persistedRecords: summarizeMemoryConsolidation(records),
              },
            });
            if (outcome) {
              await deps.traces.appendMemoryConsolidation(requestId, user.id, {
                type: "memory_consolidation",
                startedAt,
                durationMs: Date.now() - startedAt,
                outcome: redactSensitiveValue(outcome),
              });
            }
          } catch (error: any) {
            console.error("[consolidate] 失败:", error.message);
            observation.update({
              level: "ERROR",
              output: { errorClass: error.name ?? "Error" },
            });
          } finally {
            observation.end();
          }
        };
        // Prompt Pipe：构造段 → 排序 → 预算裁剪 → 渲染 system prompt。
        // segments 同时透传给 loop 写进 trace，供详情页按段展示。
        const prompt = buildPromptPipe({
          userMessage: lastUser?.content ?? "",
          userProfile: userProfile.content,
          userProfileMetadata: {
            type: "user_profile",
            revision: userProfile.revision,
            updatedAt: userProfile.updatedAt,
            contentChars: userProfile.content.length,
          },
          memoryOperation: renderMemoryOperationContext(explicitForgetResult),
          memory: memorySystem,
          memoryRecallHint,
          webSearchEnabled: enableWebSearch,
          toolOrchestration: renderToolOrchestrationPolicy(
            routeToolDefinitions,
            retrievalPlan,
          ),
          retrievalPlan,
          maxTokens: 4200,
        });
        const systemPrompt = prompt.systemPrompt;
        const systemSegments = prompt.segments;
        const injectedUserProfileSegment = systemSegments.find((segment) => segment.kind === "user-profile");
        const safeInjectedUserProfile = redactSensitiveValue(injectedUserProfileSegment?.content ?? "");
        const userProfileTraceStep: Omit<UserProfileTraceStep, "index"> = {
          type: "user_profile",
          startedAt: Date.now(),
          durationMs: 0,
          configured: userProfile.configured,
          injected: Boolean(injectedUserProfileSegment),
          revision: userProfile.revision,
          updatedAt: userProfile.updatedAt,
          contentChars: userProfile.content.length,
          injectedChars: injectedUserProfileSegment?.content.length ?? 0,
          content: safeInjectedUserProfile,
          error: userProfileLoadError ? redactSensitiveValue(userProfileLoadError) : undefined,
        };
        const profileObservation = langfuseTrace.startObservation("user-profile.load", {
          input: {
            configured: userProfile.configured,
            revision: userProfile.revision,
            updatedAt: userProfile.updatedAt,
            content: safeUserProfile.content,
          },
          metadata: withSpanLabel("user-profile.load", {
            requestId,
            revision: userProfile.revision,
            contentChars: userProfile.content.length,
          }),
          level: userProfileLoadError ? "ERROR" : "DEFAULT",
        });
        profileObservation.update({
          output: {
            injected: Boolean(injectedUserProfileSegment),
            injectedChars: injectedUserProfileSegment?.content.length ?? 0,
            content: safeInjectedUserProfile,
            error: userProfileLoadError,
          },
        });
        profileObservation.end();
        langfuseTrace.update({
          metadata: withSpanLabel("agent-chat", {
            requestId,
            sessionId,
            userId: user.id,
            model: selectedModel,
            traceInput: safeTraceInput,
            retrievalPlan: safeRetrievalPlan,
            userProfile: {
              ...safeUserProfile,
              injected: Boolean(injectedUserProfileSegment),
              injectedChars: injectedUserProfileSegment?.content.length ?? 0,
              injectedContent: safeInjectedUserProfile,
            },
          }),
        });
        pendingTrace = createTrace(requestId, sessionId);
        if (memoryRecallTraceStep) {
          prependMemoryRecallTraceStep(pendingTrace, memoryRecallTraceStep);
        }
        prependUserProfileTraceStep(pendingTrace, userProfileTraceStep);
        const contextPlan = buildContextPlan({
          model: selectedModel,
          windowTokens: selectedRuntimeModel.contextWindow,
          outputReserveTokens: 4_096,
          messages: loopMessages,
          originalMessageCount: hydratedContext.originalMessageCount,
          historySource: hydratedContext.source,
          tools,
          prompt,
          snapshotId: hydratedContext.snapshot?.id,
        });
        const persistSnapshot = async (snapshotMessages: typeof loopMessages) => {
          if (!sessionId) return;
          const snapshot = deps.sessions.createSnapshot({
            previous: hydratedContext.snapshot ?? undefined,
            userId: user.id,
            sessionId,
            model: selectedModel,
            messages: stripInlineImagesForPersistence(snapshotMessages),
          });
          await deps.sessions.saveSnapshot(snapshot);
          hydratedContext.snapshot = snapshot;
        };

        // 异步写入 sessions 表，不阻塞响应（和 consolidate 同一模式）
        if (sessionId && systemPrompt) {
          void deps.sessions.updateSystemPrompt({
            userId: user.id,
            sessionId,
            systemPrompt,
          }).catch((e: any) =>
            console.error("[memory] system_prompt 写入失败:", e.message),
          );
        }

        const planInput = {
          messages: loopMessages,
          tools,
          toolRegistry,
          maxToolIterations,
          allToolSources,
          requestId,
          sessionId,
          systemPrompt,
          systemSegments,
          userId: user.id,
          model: selectedModel,
          retrievalPlan,
          contextPlan,
          shouldStop: () => req.signal.aborted || closed,
          onProgress: (plan: PlanProgressEventData) => enqueueEvent({ type: "plan_progress", plan }, enqueueText),
          onReasoning: (reasoning: import("@/lib/agent/runtime/events").ReasoningEventData) =>
            enqueueEvent({ type: "reasoning", reasoning }, enqueueText),
        };
        const requiresPlanReview = shouldUsePlanAndExecute(lastUser?.content ?? "");
        if (!approvedPlan && requiresPlanReview) {
          const proposal = await createPlanProposal(planInput).catch((error: any) => {
            console.error("[plan] 规划失败，停止执行:", error.message);
            return null;
          });
          if (proposal) {
            const proposalText = "我已生成执行计划。请审核、修改后确认执行。";
            enqueueEvent({ type: "plan_proposal", plan: proposal }, enqueueText);
            enqueueEvent({ type: "text", content: proposalText }, enqueueText);
            void deps.sessions.persistTurn({
              userId: user.id,
              sessionId,
              userMessage: lastUser?.content,
              assistantMessage: proposalText,
            }).catch((e: any) =>
              console.error("[session] 保存计划提案失败:", e.message),
            );
            await persistSnapshot([
              ...loopMessages,
              { role: "assistant", content: proposalText },
            ]).catch((error: any) =>
              console.error("[context-snapshot] 保存计划提案失败:", error.message));
            langfuseTrace.update({
              output: { completed: true, status: "awaiting_plan_approval", plan: proposal },
            });
            langfuseTrace.setTraceIO({ input: traceDisplayInput, output: proposal });
            if (pendingTrace) {
              pendingTrace.completed = true;
              pendingTrace.stopReason = "completed";
              pendingTrace.endedAt = Date.now();
              pendingTrace.totalDurationMs = pendingTrace.endedAt - pendingTrace.startedAt;
            }
            await savePendingTrace();
            enqueueEvent({ type: "done" }, enqueueText);
            closeStream();
            return;
          }
          const failureText = "未能生成可审核的执行计划，因此没有执行任何工具。请调整任务后重试。";
          enqueueEvent({ type: "text", content: failureText }, enqueueText);
          langfuseTrace.update({
            output: { completed: false, status: "plan_generation_failed" },
            level: "WARNING",
            statusMessage: failureText,
          });
          langfuseTrace.setTraceIO({ input: traceDisplayInput, output: { error: failureText } });
          if (pendingTrace) {
            pendingTrace.completed = false;
            pendingTrace.stopReason = "error";
            pendingTrace.endedAt = Date.now();
            pendingTrace.totalDurationMs = pendingTrace.endedAt - pendingTrace.startedAt;
          }
          await savePendingTrace();
          enqueueEvent({ type: "done" }, enqueueText);
          closeStream();
          return;
        }
        const agentLoopResult = approvedPlan
          ? await executePlan(planInput, approvedPlan, planExecution)
          : await runAgentLoop(
          loopMessages,
          tools,
          toolRegistry,
          maxToolIterations,
          allToolSources,
          enqueueText,
          requestId,
          sessionId,
          undefined, // deps 用默认
          systemPrompt, // ② 注入召回的记忆和联网搜索策略
          () => req.signal.aborted || closed,
          selectedModel,
          systemSegments, // 段化结构，写进 trace 供详情页按段展示
          user.id,
          retrievalPlan,
          [],
          contextPlan,
        );
        if (memoryRecallTraceStep) {
          prependMemoryRecallTraceStep(agentLoopResult.trace, memoryRecallTraceStep);
        }
        prependUserProfileTraceStep(agentLoopResult.trace, userProfileTraceStep);
        pendingTrace = agentLoopResult.trace;
        loopMessages = agentLoopResult.loopMessages;

        const lastUserMessage = [...requestMessages]
          .reverse()
          .find((message) => message.role === "user")?.content;

        if (agentLoopResult.completed) {
          const assistantMessage = extractLastAssistantText(agentLoopResult.loopMessages);
          const safeAssistantMessage = redactSensitiveValue(assistantMessage);
          langfuseTrace.update({
            output: {
              completed: true,
              stopReason: agentLoopResult.stopReason,
              assistantMessage: safeAssistantMessage,
            },
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: safeAssistantMessage,
          });
          void deps.sessions.persistTurn({
            userId: user.id,
            sessionId,
            userMessage: lastUserMessage,
            assistantMessage,
          }).catch((e: any) =>
            console.error("[session] 写入历史失败:", e.message),
          );
          await persistSnapshot(loopMessages).catch((error: any) =>
            console.error("[context-snapshot] 保存失败:", error.message));
          projectTraceObservations(agentLoopResult.trace);
          await savePendingTrace();
          if (!explicitForgetHandled) {
            void consolidateWithObservation(loopMessages);
          }
          enqueueEvent({ type: "done" }, enqueueText);
          closeStream();
          return;
        }
        // 适配器：把第二阶段的纯文本统一包成 text 事件再写流，
        // 这样 forwardTextStream 本身一行不用改（签名仍是 (string)=>boolean）
        const enqueueTextEvent = (t: string) =>
          enqueueEvent({ type: "text", content: t }, enqueueText);
        if (agentLoopResult.stopReason === "max_iterations") {
          enqueueTextEvent("\n\n工具调用轮数已达到上限，我会基于当前结果总结。\n\n");
        } else if (agentLoopResult.stopReason === "repeated_tool_call") {
          enqueueTextEvent("\n\n检测到重复工具调用，我会基于当前结果总结。\n\n");
        }
        let finalAssistantText = "";
        const evidenceBundles = agentLoopResult.evidenceBundles ?? [];
        // 请求级约束负责“用户明确要求来源但模型漏调工具”的情况；工具级约束
        // 负责“实际拿到了 cited_evidence 工具证据”的情况。这里只决定 Trace
        // 报告里的 evidenceRequired，不再据此缓冲或修改最终回答。
        const evidenceRequired = requiresCitedEvidence({
          sourceEvidenceRequired: retrievalPlan.evidenceRequired,
          toolEvidenceRequired: agentLoopResult.toolEvidenceRequired,
        });
        // 有硬要求或本轮拿到过证据时生成校验报告；报告只进入 Trace/Eval。
        const shouldValidateEvidence = evidenceRequired
          || mergeEvidenceBundles(evidenceBundles).length > 0;
        // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
        let stream;
        let finalReasoningContent = "";
        stream = await streamModelResponse(loopMessages, systemPrompt, selectedModel, {
          operation: "final-answer",
          requestId,
          sessionId,
          userId: user.id,
          messageCount: loopMessages.length,
        }, (text) => {
          finalReasoningContent += text;
          enqueueEvent({
            type: "reasoning",
            reasoning: {
              id: `${requestId}:final`,
              modelCallIndex: agentLoopResult.metrics.modelCallCount + 1,
              content: text,
            },
          }, enqueueText);
        });
        // 遍历 API 推送的每个事件块（chunk）
        // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
        // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
        const finalStopReason = await forwardTextStream(
          stream,
          (text) => {
            finalAssistantText += text;
            return enqueueTextEvent(text);
          },
          () => req.signal.aborted || closed,
        );
        finalAssistantText = sanitizeModelText(finalAssistantText);

        if (req.signal.aborted || closed) {
          // Agent Loop 已有部分执行记录，但用户中止不应被统计为成功完成。
          agentLoopResult.trace.completed = false;
          agentLoopResult.trace.stopReason = "aborted";
          agentLoopResult.trace.endedAt = Date.now();
          agentLoopResult.trace.totalDurationMs =
            agentLoopResult.trace.endedAt - agentLoopResult.trace.startedAt;
          langfuseTrace.update({
            output: {
              completed: false,
              stopReason: "aborted",
              assistantMessage: redactSensitiveValue(finalAssistantText),
            },
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: redactSensitiveValue(finalAssistantText),
          });
          projectTraceObservations(agentLoopResult.trace);
          await savePendingTrace();
          closeStream();
          return;
        }
        if (shouldValidateEvidence) {
          const validationStartedAt = Date.now();
          const report = verifyGroundedAnswer(
            finalAssistantText,
            evidenceBundles,
            { evidenceRequired },
          );
          agentLoopResult.trace.steps.push({
            type: "answer_validation",
            index: agentLoopResult.trace.steps.length,
            startedAt: validationStartedAt,
            durationMs: Date.now() - validationStartedAt,
            report,
            // 校验结果仅上报；用户始终收到上面已经流式发送的原始回答。
            guarded: false,
          });
        }
        if (allToolSources.length > 0) {
          enqueueSources(allToolSources, enqueueText);
        }
        if (finalStopReason === "max_tokens") {
          const maxTokenNotice = "\n\n（输出达到模型单次回复上限，内容可能未完整生成。）";
          finalAssistantText += maxTokenNotice;
          enqueueTextEvent(maxTokenNotice);
        }
        void deps.sessions.persistTurn({
          userId: user.id,
          sessionId,
          userMessage: lastUserMessage,
          assistantMessage: finalAssistantText,
        }).catch((e: any) =>
          console.error("[session] 写入历史失败:", e.message),
        );
        const completedMessages = [
          ...loopMessages,
          {
            role: "assistant" as const,
            content: finalAssistantText,
            ...(finalReasoningContent ? { reasoning_content: finalReasoningContent } : {}),
          },
        ];
        await persistSnapshot(completedMessages).catch((error: any) =>
          console.error("[context-snapshot] 保存失败:", error.message));
        langfuseTrace.update({
          output: {
            completed: true,
            stopReason: finalStopReason ?? "end_turn",
            assistantMessage: redactSensitiveValue(finalAssistantText),
          },
        });
        langfuseTrace.setTraceIO({
          input: traceDisplayInput,
          output: redactSensitiveValue(finalAssistantText),
        });
        agentLoopResult.trace.endedAt = Date.now();
        agentLoopResult.trace.totalDurationMs =
          agentLoopResult.trace.endedAt - agentLoopResult.trace.startedAt;
        // 工具循环虽可能因上限退出，但最终回答流成功结束后，整次请求才算完成。
        agentLoopResult.trace.completed = true;
        agentLoopResult.trace.stopReason =
          finalStopReason === "max_tokens" ? "max_tokens" : "completed";
        projectTraceObservations(agentLoopResult.trace);
        await savePendingTrace();
        if (!explicitForgetHandled) {
          void consolidateWithObservation(completedMessages);
        }
        // 所有事件处理完毕，发 done 事件后关闭流，告诉浏览器"传输结束"
        enqueueEvent({ type: "done" }, enqueueText);
        closeStream();
      } catch (error: any) {
        if (pendingTrace) {
          // 保留已完成的步骤，并用终态覆盖循环中的临时 stopReason，供线上评分正确归类。
          pendingTrace.completed = false;
          pendingTrace.stopReason = req.signal.aborted || closed ? "aborted" : "error";
          pendingTrace.endedAt = Date.now();
          pendingTrace.totalDurationMs = pendingTrace.endedAt - pendingTrace.startedAt;
          projectTraceObservations(pendingTrace);
        }
        await savePendingTrace();
        if (req.signal.aborted || closed) {
          langfuseTrace.update({
            output: {
              completed: false,
              stopReason: "aborted",
              error: error.message || "未知错误",
            },
            level: "WARNING",
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: {
              error: error.message || "未知错误",
              aborted: true,
            },
          });
          closeStream();
          return;
        }
        // 发送 error 事件（替代 __ERROR__ marker）
        enqueueEvent(
          {
            type: "error",
            error: "流式响应中断",
            message: error.message || "未知错误",
          },
          enqueueText,
        );
        langfuseTrace.update({
          output: {
            completed: false,
            stopReason: "error",
            error: error.message || "未知错误",
          },
          level: "ERROR",
          statusMessage: error.message || "未知错误",
        });
        langfuseTrace.setTraceIO({
          input: traceDisplayInput,
          output: {
            error: error.message || "未知错误",
          },
        });
        closeStream();
      }
      });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
