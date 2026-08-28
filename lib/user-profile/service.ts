import { getSupabase } from "@/lib/platform/supabase";
import {
  USER_PROFILE_MAX_CHARS,
  type UserProfileSnapshot,
  type UserProfileView,
} from "./types";

type UserProfileRow = {
  content: string;
  revision: number;
  updated_at: string;
};

const cache = new Map<string, { expiresAt: number; value: UserProfileSnapshot }>();

function isMissingTable(error: { code?: string; message?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function emptySnapshot(): UserProfileSnapshot {
  return {
    content: "",
    configured: false,
    revision: 0,
  };
}

function fromRow(row: UserProfileRow): UserProfileSnapshot {
  const content = row.content.trim();
  return {
    content,
    configured: content.length > 0,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

async function readRow(userId: string): Promise<UserProfileRow | null> {
  const { data, error } = await getSupabase()
    .from("user_agent_profiles")
    .select("content,revision,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      throw new Error("用户画像数据表尚未创建，请先执行 20260828-user-agent-profile.sql");
    }
    throw new Error(`读取用户画像失败: ${error.message}`);
  }
  return data as UserProfileRow | null;
}

export async function resolveUserProfile(userId: string): Promise<UserProfileSnapshot> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await readRow(userId);
  const value = row ? fromRow(row) : emptySnapshot();
  cache.set(userId, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

export async function getUserProfileView(userId: string): Promise<UserProfileView> {
  const snapshot = await resolveUserProfile(userId);
  return {
    ...snapshot,
    maxChars: USER_PROFILE_MAX_CHARS,
  };
}

export async function updateUserProfile(input: { userId: string; content: string }) {
  const content = input.content.trim();
  if (content.length > USER_PROFILE_MAX_CHARS) {
    throw new Error(`用户画像不能超过 ${USER_PROFILE_MAX_CHARS} 个字符`);
  }

  const existing = await readRow(input.userId);
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("user_agent_profiles")
    .upsert({
      user_id: input.userId,
      content,
      revision: (existing?.revision ?? 0) + 1,
      updated_at: now,
    }, { onConflict: "user_id" });
  if (error) throw new Error(`保存用户画像失败: ${error.message}`);
  cache.delete(input.userId);
  return getUserProfileView(input.userId);
}
