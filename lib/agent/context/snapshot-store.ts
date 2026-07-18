import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { compactLoopMessages, CONTEXT_SUMMARY_MARKER } from "@/lib/agent/runtime/compaction";
import { estimateTokens } from "@/lib/agent/runtime/budget";
import { CONTEXT_POLICY } from "./plan";
import type { ContextSnapshot } from "./types";

const TABLE = "agent_context_snapshots";
const SNAPSHOT_MESSAGE_TOKEN_LIMIT = 24_000;

function hashContent(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifactReferences(messages: Anthropic.MessageParam[]) {
  const text = JSON.stringify(messages);
  return Array.from(new Set(
    text.match(/\b(?:artifact_id|artifactId)[\\\"]*\s*[:=][\\\"]*\s*[a-zA-Z0-9_-]+/g) ?? [],
  )).slice(0, 100);
}

function summaryFromMessages(messages: Anthropic.MessageParam[]) {
  const summary = messages.find((message) =>
    typeof message.content === "string" && message.content.includes(CONTEXT_SUMMARY_MARKER),
  );
  return typeof summary?.content === "string" ? summary.content : "";
}

export function createContextSnapshot(input: {
  previous?: ContextSnapshot;
  userId: string;
  sessionId: string;
  model: string;
  messages: Anthropic.MessageParam[];
}): ContextSnapshot {
  const sourceMessageCount = input.messages.length;
  const messages = estimateTokens(input.messages) > SNAPSHOT_MESSAGE_TOKEN_LIMIT
    ? compactLoopMessages(input.messages, {
        modelWindowTokens: 32_000,
        targetRatio: 0.5,
        primerMessages: 3,
        recentMessages: 6,
        summaryTokenBudget: 1_600,
        force: true,
      }).messages
    : input.messages;
  const now = new Date().toISOString();
  return {
    id: input.previous?.id ?? crypto.randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    version: (input.previous?.version ?? 0) + 1,
    model: input.model,
    policyVersion: CONTEXT_POLICY.version,
    summary: summaryFromMessages(messages),
    messages,
    artifactRefs: artifactReferences(messages),
    unresolvedItems: input.previous?.unresolvedItems ?? [],
    sourceMessageCount,
    contentHash: hashContent(messages),
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function fromRow(row: any): ContextSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    version: row.version,
    model: row.model,
    policyVersion: row.policy_version,
    summary: row.summary ?? "",
    messages: Array.isArray(row.messages) ? row.messages : [],
    artifactRefs: Array.isArray(row.artifact_refs) ? row.artifact_refs : [],
    unresolvedItems: Array.isArray(row.unresolved_items) ? row.unresolved_items : [],
    sourceMessageCount: row.source_message_count ?? 0,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadContextSnapshot(input: {
  userId: string;
  sessionId: string;
}): Promise<ContextSnapshot | null> {
  if (!hasSupabaseConfig()) return null;
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select("*")
    .eq("user_id", input.userId)
    .eq("session_id", input.sessionId)
    .maybeSingle();
  if (error) throw new Error(`[ContextSnapshot.load] ${error.message}`);
  return data ? fromRow(data) : null;
}

export async function saveContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
  if (!hasSupabaseConfig()) return;
  const { error } = await getSupabase().from(TABLE).upsert({
    id: snapshot.id,
    user_id: snapshot.userId,
    session_id: snapshot.sessionId,
    version: snapshot.version,
    model: snapshot.model,
    policy_version: snapshot.policyVersion,
    summary: snapshot.summary,
    messages: snapshot.messages,
    artifact_refs: snapshot.artifactRefs,
    unresolved_items: snapshot.unresolvedItems,
    source_message_count: snapshot.sourceMessageCount,
    content_hash: snapshot.contentHash,
    updated_at: snapshot.updatedAt,
  }, { onConflict: "user_id,session_id" });
  if (error) throw new Error(`[ContextSnapshot.save] ${error.message}`);
}
