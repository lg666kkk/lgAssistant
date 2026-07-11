import { getSupabase } from "@/lib/supabase";

export type KnowledgeResetOptions = {
  userId: string;
  includeRag?: boolean;
  includeCompiledWiki?: boolean;
  confirm?: boolean;
};

export type KnowledgeResetCounts = {
  notionPages: number;
  documents: number;
  compiledWikiPages: number;
  compiledWikiEdges: number;
  knowledgeProfiles: number;
};

export type KnowledgeResetResult = {
  deleted: boolean;
  includeRag: boolean;
  includeCompiledWiki: boolean;
  counts: KnowledgeResetCounts;
};

const emptyCounts: KnowledgeResetCounts = {
  notionPages: 0,
  documents: 0,
  compiledWikiPages: 0,
  compiledWikiEdges: 0,
  knowledgeProfiles: 0,
};

async function countRows(table: string, userId: string) {
  const { count, error } = await getSupabase()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`统计 ${table} 失败: ${error.message}`);
  }

  return count ?? 0;
}

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("does not exist") || message.includes("schema cache");
}

async function countRowsIfExists(table: string, userId: string) {
  try {
    return await countRows(table, userId);
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

export async function previewKnowledgeReset(
  options: KnowledgeResetOptions,
): Promise<KnowledgeResetCounts> {
  const includeRag = options.includeRag ?? true;
  const includeCompiledWiki = options.includeCompiledWiki ?? true;
  const counts = { ...emptyCounts };

  if (includeRag) {
    const [notionPages, documents] = await Promise.all([
      countRows("notion_pages", options.userId),
      countRows("documents", options.userId),
    ]);
    counts.notionPages = notionPages;
    counts.documents = documents;
  }

  if (includeCompiledWiki) {
    const [compiledWikiPages, compiledWikiEdges, knowledgeProfiles] = await Promise.all([
      countRows("compiled_wiki_pages", options.userId),
      countRows("compiled_wiki_edges", options.userId),
      countRowsIfExists("knowledge_profiles", options.userId),
    ]);
    counts.compiledWikiPages = compiledWikiPages;
    counts.compiledWikiEdges = compiledWikiEdges;
    counts.knowledgeProfiles = knowledgeProfiles;
  }

  return counts;
}

async function deleteRows(table: string, userId: string) {
  const { error } = await getSupabase()
    .from(table)
    .delete()
    .eq("user_id", userId);

  if (error) {
    throw new Error(`删除 ${table} 失败: ${error.message}`);
  }
}

async function deleteRowsIfExists(table: string, userId: string) {
  try {
    await deleteRows(table, userId);
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

export async function resetKnowledgeBase(
  options: KnowledgeResetOptions,
): Promise<KnowledgeResetResult> {
  const includeRag = options.includeRag ?? true;
  const includeCompiledWiki = options.includeCompiledWiki ?? true;

  if (!includeRag && !includeCompiledWiki) {
    return {
      deleted: false,
      includeRag,
      includeCompiledWiki,
      counts: { ...emptyCounts },
    };
  }

  const counts = await previewKnowledgeReset({
    ...options,
    includeRag,
    includeCompiledWiki,
  });

  if (!options.confirm) {
    return {
      deleted: false,
      includeRag,
      includeCompiledWiki,
      counts,
    };
  }

  if (includeCompiledWiki) {
    await deleteRowsIfExists("knowledge_profiles", options.userId);
    await deleteRows("compiled_wiki_edges", options.userId);
    await deleteRows("compiled_wiki_pages", options.userId);
  }

  if (includeRag) {
    await deleteRows("documents", options.userId);
    await deleteRows("notion_pages", options.userId);
  }

  return {
    deleted: true,
    includeRag,
    includeCompiledWiki,
    counts,
  };
}
