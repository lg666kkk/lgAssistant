import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/supabase";
import { generateTextWithProvider } from "@/lib/agent/runtime/model-provider";
import { defaultChatModel } from "@/lib/agent/models";

const COMPILER_VERSION = "llm-wiki-page-v1";
const MAX_SOURCE_CHARS = 12000;

export type WikiCompileEvent = {
  type:
    | "compile_start"
    | "source_loaded"
    | "page_skipped"
    | "llm_start"
    | "page_written"
    | "edges_written"
    | "compile_done"
    | "compile_failed";
  message: string;
  pageId?: string;
  pageTitle?: string;
  slug?: string;
  totalPages?: number;
  metadata?: Record<string, unknown>;
};

export type WikiCompileOptions = {
  userId?: string;
  pageIds?: string[];
  force?: boolean;
  onEvent?: (event: WikiCompileEvent) => void;
};

type SourcePage = {
  id: string;
  page_id: string;
  page_title: string;
  page_url: string;
  last_synced_at: string | null;
  metadata?: Record<string, unknown> | null;
};

type SourceDocument = {
  id: string;
  page_id: string;
  chunk_index: number;
  content: string;
  metadata?: Record<string, unknown> | null;
};

type CompiledWiki = {
  title: string;
  slug: string;
  summary: string;
  content: string;
  concepts: string[];
  links: Array<{
    target: string;
    relation: string;
    evidence: string;
  }>;
};

export async function compileWiki(options: WikiCompileOptions = {}) {
  const supabase = getSupabase();
  emit(options, {
    type: "compile_start",
    message: "开始编译知识库",
  });

  let query = supabase
    .from("notion_pages")
    .select("id,page_id,page_title,page_url,last_synced_at,metadata")
    .order("last_synced_at", { ascending: false });

  if (options.userId) {
    query = query.eq("user_id", options.userId);
  }

  if (options.pageIds?.length) {
    query = query.in("page_id", options.pageIds);
  }

  const { data: pages, error: pagesError } = await query;
  if (pagesError) throw new Error(`读取 Notion 页面失败: ${pagesError.message}`);

  const sourcePages = (pages ?? []) as SourcePage[];
  emit(options, {
    type: "source_loaded",
    totalPages: sourcePages.length,
    message: `找到 ${sourcePages.length} 个已同步页面`,
  });

  const results = [];
  for (const page of sourcePages) {
    try {
      const result = await compileOnePage(page, options);
      results.push(result);
    } catch (error) {
      emit(options, {
        type: "compile_failed",
        pageId: page.page_id,
        pageTitle: page.page_title,
        message: error instanceof Error ? error.message : "编译失败",
      });
    }
  }

  emit(options, {
    type: "compile_done",
    totalPages: sourcePages.length,
    message: `编译完成：${results.length}/${sourcePages.length} 个页面`,
    metadata: { results },
  });

  return results;
}

async function compileOnePage(page: SourcePage, options: WikiCompileOptions) {
  const supabase = getSupabase();
  let docsQuery = supabase
    .from("documents")
    .select("id,page_id,chunk_index,content,metadata")
    .eq("notion_page_id", page.id)
    .order("chunk_index", { ascending: true });

  if (options.userId) {
    docsQuery = docsQuery.eq("user_id", options.userId);
  }

  const { data: docs, error: docsError } = await docsQuery;
  if (docsError) throw new Error(`读取 chunks 失败: ${docsError.message}`);

  const documents = (docs ?? []) as SourceDocument[];
  const sourceText = documents.map((doc) => doc.content).join("\n\n");
  const sourceHash = hashText([
    page.page_id,
    page.page_title,
    sourceText,
    COMPILER_VERSION,
  ].join("\n"));
  const slug = makeSlug(page.page_title, page.page_id);

  emit(options, {
    type: "source_loaded",
    pageId: page.page_id,
    pageTitle: page.page_title,
    slug,
    message: `已加载 ${documents.length} 个 chunk：${page.page_title}`,
    metadata: { sourceChars: sourceText.length },
  });

  let existingQuery = supabase
    .from("compiled_wiki_pages")
    .select("slug,content_hash")
    .eq("slug", slug);

  if (options.userId) {
    existingQuery = existingQuery.eq("user_id", options.userId);
  }

  const { data: existing, error: existingError } = await existingQuery.maybeSingle();

  if (existingError) throw new Error(`读取编译页失败: ${existingError.message}`);

  if (!options.force && existing?.content_hash === sourceHash) {
    emit(options, {
      type: "page_skipped",
      pageId: page.page_id,
      pageTitle: page.page_title,
      slug,
      message: `编译产物未变化，跳过：${page.page_title}`,
    });
    return { pageId: page.page_id, slug, status: "skipped" };
  }

  emit(options, {
    type: "llm_start",
    pageId: page.page_id,
    pageTitle: page.page_title,
    slug,
    message: `调用 LLM 编译：${page.page_title}`,
  });

  const compiled = await compileWithLLM({
    page,
    sourceText: sourceText.slice(0, MAX_SOURCE_CHARS),
    slug,
  });
  const normalized = normalizeCompiledWiki(compiled, page, slug);

  const sourceDocumentIds = documents
    .map((doc) => doc.id)
    .filter((id): id is string => typeof id === "string");

  const { error: upsertError } = await supabase
    .from("compiled_wiki_pages")
    .upsert(
      {
        slug: normalized.slug,
        user_id: options.userId,
        title: normalized.title,
        summary: normalized.summary,
        content: normalized.content,
        concepts: normalized.concepts,
        source_page_ids: [page.page_id],
        source_document_ids: sourceDocumentIds,
        content_hash: sourceHash,
        metadata: {
          compiler_version: COMPILER_VERSION,
          source_page_title: page.page_title,
          source_page_url: page.page_url,
        },
        updated_at: new Date().toISOString(),
      },
      options.userId ? { onConflict: "user_id,slug" } : { onConflict: "slug" },
    );

  if (upsertError) throw new Error(`写入 wiki 页面失败: ${upsertError.message}`);

  emit(options, {
    type: "page_written",
    pageId: page.page_id,
    pageTitle: normalized.title,
    slug: normalized.slug,
    message: `已写入 wiki 页面：${normalized.title}`,
    metadata: { concepts: normalized.concepts },
  });

  let deleteEdgesQuery = supabase.from("compiled_wiki_edges").delete().eq("from_slug", normalized.slug);
  if (options.userId) {
    deleteEdgesQuery = deleteEdgesQuery.eq("user_id", options.userId);
  }
  await deleteEdgesQuery;
  const edgeRows = normalized.links
    .filter((link) => link.target && link.relation)
    .map((link) => ({
      user_id: options.userId,
      from_slug: normalized.slug,
      to_label: link.target.slice(0, 120),
      relation: link.relation.slice(0, 120),
      evidence: link.evidence.slice(0, 500),
      metadata: { source_page_id: page.page_id },
    }));

  if (edgeRows.length > 0) {
    const { error: edgesError } = await supabase
      .from("compiled_wiki_edges")
      .insert(edgeRows);
    if (edgesError) throw new Error(`写入 wiki 关系失败: ${edgesError.message}`);
  }

  emit(options, {
    type: "edges_written",
    pageId: page.page_id,
    pageTitle: normalized.title,
    slug: normalized.slug,
    message: `已写入 ${edgeRows.length} 条知识关系`,
  });

  return {
    pageId: page.page_id,
    slug: normalized.slug,
    status: "compiled",
    title: normalized.title,
  };
}

async function compileWithLLM(input: {
  page: SourcePage;
  sourceText: string;
  slug: string;
}): Promise<CompiledWiki> {
  const prompt = [
    `页面标题：${input.page.page_title}`,
    `页面链接：${input.page.page_url}`,
    "",
    "原始资料：",
    input.sourceText,
  ].join("\n");

  const text = await generateTextWithProvider({
    model: defaultChatModel,
    maxOutputTokens: 3000,
    system: [
      "你是 LLM 编译知识库的知识编译器。",
      "任务：把原始资料编译成结构化 wiki 页面，而不是简单摘要。",
      "要求：保留关键概念、决策、流程、约束、可复用结论，并抽取和其它概念可能有关的关系。",
      "只输出 JSON，不要 Markdown 代码围栏。",
      '格式：{"title":"页面标题","slug":"稳定英文或拼音短 slug","summary":"一句话摘要","content":"Markdown 正文","concepts":["概念"],"links":[{"target":"相关概念或页面","relation":"关系","evidence":"证据"}]}',
    ].join("\n"),
    prompt,
  });

  return parseCompiledJson(text);
}

function parseCompiledJson(text: string): CompiledWiki {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM 未返回 JSON");
  return JSON.parse(match[0]) as CompiledWiki;
}

function normalizeCompiledWiki(value: CompiledWiki, page: SourcePage, fallbackSlug: string): CompiledWiki {
  return {
    title: String(value.title || page.page_title).slice(0, 120),
    slug: makeSlug(String(value.slug || fallbackSlug), page.page_id),
    summary: String(value.summary || "").slice(0, 500),
    content: String(value.content || `# ${page.page_title}\n\n${value.summary || ""}`).trim(),
    concepts: Array.isArray(value.concepts)
      ? value.concepts.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20)
      : [],
    links: Array.isArray(value.links)
      ? value.links.map((link) => ({
          target: String(link.target || "").trim(),
          relation: String(link.relation || "").trim(),
          evidence: String(link.evidence || "").trim(),
        })).filter((link) => link.target && link.relation).slice(0, 30)
      : [],
  };
}

function makeSlug(title: string, pageId: string) {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${ascii || "wiki"}-${pageId.slice(0, 8)}`;
}

function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function emit(options: WikiCompileOptions, event: WikiCompileEvent) {
  options.onEvent?.(event);
}
