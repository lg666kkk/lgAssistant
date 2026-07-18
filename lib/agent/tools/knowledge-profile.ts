import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/platform/supabase";
import { defaultChatModel } from "@/lib/agent/models";
import { generateTextWithProvider } from "@/lib/agent/runtime/model-provider";

type CompiledWikiProfileRow = {
  title?: string | null;
  summary?: string | null;
  concepts?: string[] | null;
  updated_at?: string | null;
};

type NotionPageProfileRow = {
  page_title?: string | null;
  last_synced_at?: string | null;
};

type StoredKnowledgeProfileRow = {
  source_hash?: string | null;
  profile?: string | null;
  metadata?: Record<string, unknown> | null;
  updated_at?: string | null;
};

const MAX_PROFILE_CHARS = 360;
const MAX_SUMMARY_CHARS = 220;
const PROFILE_TYPE = "search_notes_tool";

const profileCache = new Map<
  string,
  {
    hash: string;
    profile: string;
  }
>();
const profileRefreshes = new Map<string, Promise<string | undefined>>();

export type KnowledgeProfileSnapshot = {
  profile: string;
  sourceHash: string;
  indexVersion: string;
  updatedAt?: string;
};

function uniqueStrings(values: Array<string | null | undefined>, limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function truncateProfile(text: string) {
  if (text.length <= MAX_PROFILE_CHARS) return text;
  return `${text.slice(0, MAX_PROFILE_CHARS - 1)}...`;
}

function compactText(text: string, maxChars: number) {
  const normalized = text
    .replace(/[#*_`>\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

function removeTitlePrefix(summary: string, title?: string | null) {
  const cleanTitle = title?.trim();
  if (!cleanTitle) return summary;

  return summary
    .replace(new RegExp(`^${escapeRegExp(cleanTitle)}\\s*[:：,，-]?\\s*`, "i"), "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashProfileInput(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLlmProfile(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function readStoredProfile(input: {
  userId: string;
  sourceHash: string;
}) {
  const { data, error } = await getSupabase()
    .from("knowledge_profiles")
    .select("source_hash,profile")
    .eq("user_id", input.userId)
    .eq("profile_type", PROFILE_TYPE)
    .maybeSingle();

  if (error) {
    console.warn("[knowledge-profile] 读取持久画像失败:", error.message);
    return undefined;
  }

  const row = data as StoredKnowledgeProfileRow | null;
  const profile = row?.profile?.trim();
  if (row?.source_hash === input.sourceHash && profile) {
    profileCache.set(input.userId, {
      hash: input.sourceHash,
      profile,
    });
    return profile;
  }

  return undefined;
}

async function storeProfile(input: {
  userId: string;
  sourceHash: string;
  profile: string;
  wikiSummaryCount: number;
  wikiPageCount: number;
}) {
  const { error } = await getSupabase()
    .from("knowledge_profiles")
    .upsert(
      {
        user_id: input.userId,
        profile_type: PROFILE_TYPE,
        source_hash: input.sourceHash,
        profile: input.profile,
        metadata: {
          source: "knowledge_sync_refresh",
          wiki_summary_count: input.wikiSummaryCount,
          wiki_page_count: input.wikiPageCount,
          index_version: input.sourceHash,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,profile_type" },
    );

  if (error) {
    console.warn("[knowledge-profile] 写入持久画像失败:", error.message);
  }
}

export async function readKnowledgeProfileForTool(input: {
  userId: string;
}): Promise<KnowledgeProfileSnapshot | undefined> {
  const cached = profileCache.get(input.userId);
  if (cached?.profile) {
    return {
      profile: cached.profile,
      sourceHash: cached.hash,
      indexVersion: cached.hash,
    };
  }

  const { data, error } = await getSupabase()
    .from("knowledge_profiles")
    .select("source_hash,profile,metadata,updated_at")
    .eq("user_id", input.userId)
    .eq("profile_type", PROFILE_TYPE)
    .maybeSingle();
  if (error) {
    console.warn("[knowledge-profile] 读取画像快照失败:", error.message);
    return undefined;
  }

  const row = data as StoredKnowledgeProfileRow | null;
  const profile = row?.profile?.trim();
  const sourceHash = row?.source_hash?.trim();
  if (!profile || !sourceHash) return undefined;
  profileCache.set(input.userId, { hash: sourceHash, profile });
  return {
    profile,
    sourceHash,
    indexVersion:
      typeof row?.metadata?.index_version === "string"
        ? row.metadata.index_version
        : sourceHash,
    updatedAt: row?.updated_at ?? undefined,
  };
}

export function enqueueKnowledgeProfileRefresh(input: { userId: string }) {
  const existing = profileRefreshes.get(input.userId);
  if (existing) return existing;

  const refresh = buildKnowledgeProfileForTool(input)
    .catch((error) => {
      console.error("[knowledge-profile] 异步刷新失败:", error);
      return undefined;
    })
    .finally(() => {
      profileRefreshes.delete(input.userId);
    });
  profileRefreshes.set(input.userId, refresh);
  return refresh;
}

function buildDeterministicProfile(input: {
  wikiRows: CompiledWikiProfileRow[];
  pageRows: NotionPageProfileRow[];
  wikiCount: number;
}) {
  const concepts = uniqueStrings(
    input.wikiRows.flatMap((page) => page.concepts ?? []),
    8,
  );
  const wikiSummaries = uniqueStrings(
    input.wikiRows
      .map((page) => removeTitlePrefix(page.summary?.trim() ?? "", page.title))
      .filter(Boolean)
      .map((summary) => compactText(summary, 70)),
    2,
  );
  const fallbackTitles = uniqueStrings(
    input.pageRows.map((page) => page.page_title),
    4,
  );

  const sections = [
    `当前个人知识库画像：${input.pageRows.length} 个已同步页面，${input.wikiCount} 个已编译知识页。`,
    concepts.length > 0 ? `覆盖主题：${concepts.join("、")}` : "",
    wikiSummaries.length > 0
      ? `内容摘要：${wikiSummaries.join("；")}`
      : "",
    wikiSummaries.length === 0 && fallbackTitles.length > 0
      ? `可检索页面示例：${fallbackTitles.join("、")}`
      : "",
  ].filter(Boolean);

  return truncateProfile(sections.join("\n"));
}

async function compressSummariesWithLLM(input: {
  userId: string;
  wikiRows: CompiledWikiProfileRow[];
  wikiCount: number;
}) {
  const summaries = input.wikiRows
    .map((page, index) => {
      const title = page.title?.trim() || `知识页 ${index + 1}`;
      const summary = compactText(
        removeTitlePrefix(page.summary?.trim() ?? "", page.title),
        MAX_SUMMARY_CHARS,
      );
      return summary ? `${index + 1}. ${title}: ${summary}` : "";
    })
    .filter(Boolean);

  if (summaries.length === 0) return undefined;

  const profileInput = summaries.join("\n");
  const hash = hashProfileInput(profileInput);
  const cached = profileCache.get(input.userId);
  if (cached?.hash === hash) return cached.profile;

  const stored = await readStoredProfile({
    userId: input.userId,
    sourceHash: hash,
  });
  if (stored) return stored;

  const text = await generateTextWithProvider({
    model: defaultChatModel,
    maxOutputTokens: 520,
    telemetryFunctionId: "knowledge-profile-compress",
    system: [
      "你是 search_notes 工具的知识库画像生成器。",
      "任务：把多篇已编译 wiki summary 压缩成一段工具描述补充，用来帮助 Agent 判断什么时候应该检索用户个人知识库。",
      "输出必须是中文，500 字以内，单段自然语言。",
      "内容重点：概括知识库覆盖的领域、核心主题、常见资料类型，以及适合向 search_notes 提问的问题范围。",
      "写法要求：具体、可路由、信息密度高；不要罗列页面标题，不要编号，不要 Markdown，不要说“这批 summary/这些页面”。",
      "边界要求：不要声称包含 summary 中没有体现的内容；如果主题分散，概括为几个高层主题。",
    ].join("\n"),
    prompt: [
      `已编译知识页总数：${input.wikiCount}`,
      "",
      "每页 summary：",
      profileInput,
    ].join("\n"),
    telemetryMetadata: {
      operation: "knowledge-profile-compress",
      profileType: PROFILE_TYPE,
      sourceHash: hash.slice(0, 12),
      wikiSummaryCount: summaries.length,
      wikiPageCount: input.wikiCount,
    },
  });

  const profile = normalizeLlmProfile(text);
  if (!profile) return undefined;

  profileCache.set(input.userId, { hash, profile });
  await storeProfile({
    userId: input.userId,
    sourceHash: hash,
    profile,
    wikiSummaryCount: summaries.length,
    wikiPageCount: input.wikiCount,
  });

  return profile;
}

export async function buildKnowledgeProfileForTool(input: {
  userId: string;
}): Promise<string | undefined> {
  const supabase = getSupabase();

  const [
    { data: wikiPages, count: exactWikiCount, error: wikiError },
    { data: notionPages, error: pagesError },
  ] =
    await Promise.all([
      supabase
        .from("compiled_wiki_pages")
        .select("title,summary,concepts,updated_at", { count: "exact" })
        .eq("user_id", input.userId)
        .order("updated_at", { ascending: false }),
      supabase
        .from("notion_pages")
        .select("page_title,last_synced_at")
        .eq("user_id", input.userId)
        .order("last_synced_at", { ascending: false })
        .limit(12),
    ]);

  if (wikiError && pagesError) return undefined;

  const wikiRows = (wikiPages ?? []) as CompiledWikiProfileRow[];
  const pageRows = (notionPages ?? []) as NotionPageProfileRow[];
  if (wikiRows.length === 0 && pageRows.length === 0) return undefined;

  const wikiCount = exactWikiCount ?? wikiRows.length;
  const sourceHash = hashProfileInput(JSON.stringify({
    wikiRows,
    pageRows,
    wikiCount,
  }));
  const deterministicProfile = buildDeterministicProfile({
    wikiRows,
    pageRows,
    wikiCount,
  });

  let compressedProfile: string | undefined;
  try {
    compressedProfile = await compressSummariesWithLLM({
      userId: input.userId,
      wikiRows,
      wikiCount,
    });
  } catch (error) {
    console.error("[knowledge-profile] LLM 压缩知识库画像失败:", error);
  }

  const sections = [
    compressedProfile
      ? `当前个人知识库画像：${compressedProfile}`
      : deterministicProfile,
    "当用户问题明显落在以上范围内时，优先调用本工具；若问题无关或需要公开实时信息，应改用或补充 web_search。",
  ].filter(Boolean);

  const profile = truncateProfile(sections.join("\n"));
  profileCache.set(input.userId, { hash: sourceHash, profile });
  await storeProfile({
    userId: input.userId,
    sourceHash,
    profile,
    wikiSummaryCount: wikiRows.filter((row) => row.summary?.trim()).length,
    wikiPageCount: wikiCount,
  });
  return profile;
}
