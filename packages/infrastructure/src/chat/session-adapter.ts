import type Anthropic from "@anthropic-ai/sdk";
import {
  createContextSnapshot,
  loadContextSnapshot,
  saveContextSnapshot,
} from "@/lib/agent/context/snapshot-store";
import type { ContextPlan } from "@/lib/agent/context/types";
import { RedisSessionStore } from "@/lib/agent/memory/session-store";
import { getSupabase } from "@/lib/platform/supabase";
import type { ChatSessionPort } from "@repo/application/chat/ports";

const SESSION_FALLBACK_MESSAGE_LIMIT = 15;
const sessionStore = new RedisSessionStore();

type ModelMessage = Anthropic.MessageParam;

type SessionHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

function textFromMessageContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: any) => block?.type === "text" ? [String(block.text ?? "")] : [])
    .join("\n");
}

export async function persistSessionTurn(input: {
  userId: string;
  sessionId?: string;
  userMessage?: string;
  assistantMessage?: string;
}) {
  if (!input.sessionId) return;

  if (input.userMessage?.trim()) {
    await sessionStore.append(input.userId, input.sessionId, {
      role: "user",
      content: input.userMessage,
    });
  }

  if (input.assistantMessage?.trim()) {
    await sessionStore.append(input.userId, input.sessionId, {
      role: "assistant",
      content: input.assistantMessage,
    });
  }
}

async function restoreSessionHistoryFromDatabase(input: {
  userId: string;
  sessionId?: string;
}): Promise<SessionHistoryMessage[]> {
  if (!input.sessionId) return [];

  const { data, error } = await getSupabase()
    .from("messages")
    .select("role,content,created_at")
    .eq("user_id", input.userId)
    .eq("session_id", input.sessionId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(SESSION_FALLBACK_MESSAGE_LIMIT);

  if (error) throw new Error(`从数据库恢复会话历史失败: ${error.message}`);

  return (data ?? [])
    .reverse()
    .filter((message: any) => typeof message.content === "string")
    .map((message: any) => ({
      role: message.role as "user" | "assistant",
      content: message.content as string,
    }));
}

async function hydrateRedisSessionHistory(input: {
  userId: string;
  sessionId?: string;
  history: SessionHistoryMessage[];
}) {
  if (!input.sessionId || input.history.length === 0) return;

  await sessionStore.clear(input.userId, input.sessionId);
  for (const message of input.history) {
    await sessionStore.append(input.userId, input.sessionId, message);
  }
}

export async function resolveLoopMessages(input: {
  userId: string;
  sessionId?: string;
  messages: ModelMessage[];
}) {
  if (!input.sessionId) {
    return {
      messages: [...input.messages],
      source: "client" as const,
      originalMessageCount: input.messages.length,
      snapshot: null,
    };
  }

  const snapshot = await loadContextSnapshot({
    userId: input.userId,
    sessionId: input.sessionId,
  });
  if (snapshot) {
    const currentMessage = [...input.messages].reverse().find((message) => message.role === "user");
    const snapshotMessages = [...snapshot.messages];
    const lastSnapshotMessage = snapshotMessages[snapshotMessages.length - 1];
    const duplicateCurrent = currentMessage
      && lastSnapshotMessage?.role === currentMessage.role
      && textFromMessageContent(lastSnapshotMessage.content) === textFromMessageContent(currentMessage.content)
      && !Array.isArray(currentMessage.content);
    return {
      messages: currentMessage && !duplicateCurrent
        ? [...snapshotMessages, currentMessage]
        : snapshotMessages,
      source: "snapshot" as const,
      originalMessageCount: input.messages.length,
      snapshot,
    };
  }

  let history = await sessionStore.getHistory(input.userId, input.sessionId);
  let source: ContextPlan["history"]["source"] = history.length > 0 ? "redis" : "client";
  if (history.length === 0) {
    const restoredHistory = await restoreSessionHistoryFromDatabase(input);
    if (restoredHistory.length > 0) {
      source = "database";
      const currentUserContent = textFromMessageContent(input.messages[0]?.content);
      history = restoredHistory.filter(
        (message, index) => !(
          index === restoredHistory.length - 1
          && message.role === "user"
          && message.content === currentUserContent
        ),
      );
      await hydrateRedisSessionHistory({
        userId: input.userId,
        sessionId: input.sessionId,
        history,
      });
    }
  }

  return {
    messages: history.length > 0
      ? [...history.slice(-SESSION_FALLBACK_MESSAGE_LIMIT), ...input.messages]
      : [...input.messages],
    source,
    originalMessageCount: input.messages.length,
    snapshot: null,
  };
}

async function updateSystemPrompt(input: {
  userId: string;
  sessionId: string;
  systemPrompt: string;
}) {
  const { error } = await getSupabase()
    .from("sessions")
    .update({ system_prompt: input.systemPrompt })
    .eq("id", input.sessionId)
    .eq("user_id", input.userId);
  if (error) throw new Error(`保存会话 system prompt 失败: ${error.message}`);
}

export function createChatSessionAdapter(): ChatSessionPort {
  return {
    resolveLoopMessages,
    persistTurn: persistSessionTurn,
    createSnapshot: createContextSnapshot,
    saveSnapshot: saveContextSnapshot,
    updateSystemPrompt,
  };
}
