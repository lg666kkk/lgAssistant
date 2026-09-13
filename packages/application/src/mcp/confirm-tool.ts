import { stripInlineImagesForPersistence } from "@/lib/agent/multimodal";
import { randomUUID } from "node:crypto";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { createTrace, finalizeAnswerTrace } from "@/lib/agent/runtime/trace";
import {
  getToolCallKey,
  enqueueSources,
  runAgentLoop,
  streamModelResponse,
  forwardTextStream,
  type AgentLoopResult,
} from "@/lib/agent/runtime";
import { executePlan } from "@/lib/agent/runtime/plan-execution";
import type { AgentEvent } from "@repo/contracts";
import type { ChatApplicationDependencies } from "../chat/ports";
import { createToolObservationProjector } from "../chat/tool-observations";
import { extractLastAssistantText } from "../chat/message-utils";
import { openExternalToolSession } from "./session";
import {
  checkpoint,
  confirmationEvents,
  replaceToolResult,
  toolFingerprint,
  type ConfirmationResponse,
} from "./continuation";

export async function confirmTool(
  input: {
    userId: string;
    sessionId?: string;
    token: string;
    callId: string;
    action: "confirm" | "cancel" | "answer";
  answer?: string;
    signal: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
    dependencies: ChatApplicationDependencies;
  },
  runtime = {
    runAgentLoop,
    executePlan,
    streamModelResponse,
    forwardTextStream,
  },
): Promise<ConfirmationResponse> {
  const deps = input.dependencies;
  if (!deps.confirmations) throw new Error("确认服务不可用");
  const store = deps.confirmations;
  const claimed = await store.claim(input.userId, input.token, input.callId);
  const state = claimed.state;
  let safeToRelease = true;
  let external: Awaited<ReturnType<typeof openExternalToolSession>> | undefined;
  try {
    if (state.sessionId !== input.sessionId)
      throw new Error("确认记录不属于当前会话");
    if (claimed.response) {
      for (const event of claimed.response.events) input.onEvent?.(event);
      return claimed.response;
    }
    const pending = state.pending.find((call) => call.id === input.callId);
    if (!pending) throw new Error("此调用不在待确认列表中");
    const isQuestion = pending.name === "ask_user" && pending.metadata?.status === "awaiting_user_input";
    if (input.action === "answer") {
      if (!isQuestion || typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 10000) throw new Error("回答无效，请填写问题后重新提交");
    } else if (isQuestion && input.action === "confirm") throw new Error("此工具需要回答问题，不能用执行确认代替");
    external = await openExternalToolSession({
      userId: input.userId,
      signal: input.signal,
      port: deps.externalTools,
    });
    const registry = createBuiltinToolRegistry({
      retrievalPlan: state.retrievalPlan,
    });
    external.tools.forEach((tool) => registry.register(tool));
    const tool = registry.get(pending.name);
    if (
      input.action === "confirm" &&
      (!tool || toolFingerprint(tool) !== state.fingerprints[pending.id])
    ) {
      throw new Error("工具或服务配置已变化，请取消此次调用并重新发起请求");
    }
    // Resolve the original model before executing a write. Client cannot replace it.
    await deps.userContext.resolveModel(input.userId, state.model);
    const requestId = randomUUID();
    return await deps.telemetry.withTrace(
      {
        userId: input.userId,
        sessionId: state.sessionId,
        name: "tool-confirmation-continuation",
        metadata: {
          requestId,
          parentRequestId: state.requestId,
          toolCallId: pending.id,
        },
        tags: ["tool-confirmation", "continuation"],
      },
      async ({ trace: remoteTrace }) => {
        const trace = createTrace(requestId, state.sessionId);
        const project = createToolObservationProjector(remoteTrace, requestId);
        const events: AgentEvent[] = [];
        const publish = (...items: AgentEvent[]) => {
          events.push(...items);
          for (const event of items) input.onEvent?.(event);
        };
        const emit = (text: string) => {
          for (const line of text.split("\n"))
            if (line.startsWith("data: "))
              publish(JSON.parse(line.slice(6)) as AgentEvent);
          return true;
        };
        const startedAt = Date.now();
        // From this point a crash/abort cannot unlock and retry a possibly committed write.
        safeToRelease = false;
        const result =
          input.action === "answer"
            ? { ok: true, content: JSON.stringify({ questions: pending.metadata?.questions ?? pending.metadata?.question, answer: input.answer!.trim() }), metadata: { ...pending.metadata, status: "answered", answer: input.answer!.trim() } }
            : input.action === "cancel"
            ? {
                ok: false,
                content:
                  "用户已取消此工具调用，请基于现有结果继续，勿重复请求同一操作。",
                metadata: { ...pending.metadata, status: "cancelled" },
              }
            : await executeToolCall(
                registry,
                { id: pending.id, name: pending.name, input: pending.input },
                {
                  approved: true,
                  userId: input.userId,
                  scopeId: state.sessionId,
                  requestId,
                  signal: external!.signal,
                },
              );
        const executionDurationMs = Date.now() - startedAt;
        replaceToolResult(state, pending.id, result.content, result.ok);
        state.executedToolKeys = [
          ...(state.executedToolKeys ?? []),
          getToolCallKey({
            type: "tool_use",
            id: pending.id,
            name: pending.name,
            input: pending.input,
          }),
        ];
        const persistContext = async () => {
          if (!state.sessionId) return;
          const snapshot = deps.sessions.createSnapshot({
            userId: input.userId,
            sessionId: state.sessionId,
            model: state.model,
            messages: stripInlineImagesForPersistence(state.messages),
          });
          await deps.sessions.saveSnapshot(snapshot);
        };
        // Preserve the actual receipt for subsequent ordinary chat even if generation fails.
        await persistContext().catch(() =>
          console.warn("[confirmation] snapshot save failed"),
        );
        if (result.ok && tool)
          state.capabilities = Array.from(
            new Set([...state.capabilities, ...tool.capabilities]),
          );
        state.pending = state.pending.filter((call) => call.id !== pending.id);
        trace.steps.push({
          type: "tool",
          index: 0,
          startedAt,
          durationMs: executionDurationMs,
          name: pending.name,
          toolCallId: pending.id,
          input: pending.input,
          ok: result.ok,
          contentSummary: result.content.slice(0, 1200),
          contentTruncated: result.content.length > 1200,
          contentOriginalChars: result.content.length,
          metadata: { ...result.metadata, parentRequestId: state.requestId },
          costPerUse: 0,
        });
        publish({
          type: "tool_call",
          toolCall: {
            ...pending,
            ...result,
            id: pending.id,
            name: pending.name,
            metadata: {
              ...pending.metadata,
              ...result.metadata,
              status:
                input.action === "answer" ? "answered" : input.action === "cancel"
                  ? "cancelled"
                  : result.ok
                    ? "confirmed"
                    : "failed",
              confirmationRequestId: requestId,
            },
          },
        });
        let response: ConfirmationResponse;
        if (state.pending.length) {
          response = { events, pending: true };
          trace.stopReason = "awaiting_tool_confirmation";
        } else {
          try {
            // Restore protocol messages including the original tool_use IDs and actual results.
            const tools = registry.listForModel(
              registry.list().filter((item) => state.tools.includes(item.name)),
            );
            const common = {
              messages: state.messages,
              tools,
              toolRegistry: registry,
              maxToolIterations: state.remainingIterations,
              allToolSources: [...(state.sources ?? [])],
              requestId,
              sessionId: state.sessionId,
              systemPrompt: state.system,
              userId: input.userId,
              model: state.model,
              retrievalPlan: state.retrievalPlan,
              resume: {
                executedToolKeys: state.executedToolKeys,
                spentTokens: state.spentTokens,
              },
              initialEvidenceBundles: state.evidenceBundles,
              initialCapabilities: state.capabilities,
              initialRetrievalCalls: state.retrievalCalls,
              shouldStop: () => external!.signal.aborted,
              signal: external!.signal,
              onProgress: (
                plan: import("@repo/contracts").PlanProgressEventData,
              ) => publish({ type: "plan_progress", plan }),
            };
            const resumed: AgentLoopResult = state.plan
              ? await runtime.executePlan(common, state.plan, {
                  ...state.planControl,
                  startAtStep: state.planStep ?? 0,
                })
              : await runtime.runAgentLoop(
                  state.messages,
                  tools,
                  registry,
                  state.remainingIterations,
                  common.allToolSources,
                  emit,
                  requestId,
                  state.sessionId,
                  undefined,
                  state.system,
                  common.shouldStop,
                  state.model,
                  undefined,
                  input.userId,
                  state.retrievalPlan,
                  state.evidenceBundles,
                  undefined,
                  state.capabilities,
                  undefined,
                  new Map(state.retrievalCalls),
                  external!.signal,
                  {
                    executedToolKeys: state.executedToolKeys,
                    spentTokens: state.spentTokens,
                  },
                );
            state.messages = resumed.loopMessages;
            state.sources = common.allToolSources;
            enqueueSources(common.allToolSources, emit);
            trace.steps.push(
              ...resumed.trace.steps.map((step, index) => ({
                ...step,
                index: index + 1,
              })),
            );
            trace.metrics = resumed.metrics;
            trace.stopReason = resumed.stopReason;
            trace.completed = resumed.completed;
            if (["awaiting_tool_confirmation", "awaiting_user_input"].includes(resumed.stopReason)) {
              const next = checkpoint(
                {
                  ...state,
                  requestId,
                  remainingIterations: Math.max(
                    0,
                    state.remainingIterations - resumed.metrics.modelCallCount,
                  ),
                  planStep: resumed.pausedPlanStep ?? state.planStep,
                },
                resumed,
                registry,
              );
              const token = await store.create(input.userId, next);
              publish(...confirmationEvents(next, token));
              if (resumed.stopReason === "awaiting_tool_confirmation") publish({
                type: "text",
                content: "还有一个操作需要确认，确认后我会继续。",
              });
              response = { events, pending: true };
            } else {
              if (!resumed.completed) {
                const stream = await runtime.streamModelResponse(
                  state.messages,
                  state.system,
                  state.model,
                  {
                    operation: "confirmation-final-answer",
                    requestId,
                    sessionId: state.sessionId,
                    userId: input.userId,
                  },
                  undefined,
                  external!.signal,
                );
                let content = "";
                await runtime.forwardTextStream(
                  stream,
                  (text) => {
                    content += text;
                    publish({ type: "text", content: text });
                    return true;
                  },
                  common.shouldStop,
                );
                state.messages.push({ role: "assistant", content });
              }
              if (external!.signal.aborted)
                throw new Error("继续生成已中止；工具结果已保留，请勿重复执行");
              const content =
                events
                  .flatMap((event) =>
                    event.type === "text" ? [event.content] : [],
                  )
                  .join("") || extractLastAssistantText(state.messages);
              if (content && !events.some((event) => event.type === "text"))
                publish({ type: "text", content });
              if (state.sessionId) {
                const snapshot = deps.sessions.createSnapshot({
                  userId: input.userId,
                  sessionId: state.sessionId,
                  model: state.model,
                  messages: stripInlineImagesForPersistence(state.messages),
                });
                await deps.sessions.saveSnapshot(snapshot);
                await deps.sessions.persistTurn({
                  userId: input.userId,
                  sessionId: state.sessionId,
                  assistantMessage: content,
                });
              }
              trace.completed =
                resumed.stopReason !== "aborted" &&
                resumed.stopReason !== "error";
              response = { events, pending: false };
            }
          } catch {
            trace.completed = false;
            trace.stopReason = "error";
            response = {
              events,
              pending: false,
              continuationError:
                "工具结果已记录，但后续生成失败。请发送新消息继续，勿重复执行该操作。",
            };
          }
        }
        if (input.action === "confirm") {
          trace.metrics.toolCallCount += 1;
          trace.metrics.toolDurations.push({
            name: pending.name,
            durationMs: executionDurationMs,
          });
        }
        project(trace);
        finalizeAnswerTrace(trace);
        await deps.traces
          .save(trace, input.userId)
          .catch(() => console.warn("[trace] continuation save failed"));
        remoteTrace.setTraceIO({
          input: { parentRequestId: state.requestId, toolCallId: pending.id },
          output: {
            ok: result.ok,
            pending: response.pending,
            continuationError: response.continuationError,
          },
        });
        await store.save(
          input.userId,
          input.token,
          state,
          input.callId,
          response,
        );
        return response;
      },
    );
  } finally {
    await external?.close();
    if (safeToRelease) await store.release(input.userId, input.token);
  }
}
