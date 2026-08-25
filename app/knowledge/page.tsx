"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RotateCcw, Save } from "lucide-react";
import { AuthGate } from "@/lib/auth/auth-gate";
import { authFetch } from "@/lib/auth/client";

type KnowledgePage = {
  page_id: string;
  page_title: string;
  page_url: string;
  last_edited_time: string;
  last_synced_at: string;
  chunk_count: number;
  metadata?: {
    content_hash?: string;
    embedding_model?: string;
    chunker_version?: string;
  };
};

type SyncEvent = {
  at?: string;
  type: string;
  message: string;
  pageId?: string;
  pageTitle?: string;
  status?: string;
  chunksCount?: number;
  totalPages?: number;
  metadata?: Record<string, unknown>;
};

type WikiPage = {
  slug: string;
  title: string;
  summary: string;
  concepts?: string[];
  source_page_ids?: string[];
  updated_at: string;
  metadata?: Record<string, unknown>;
};

type KnowledgeResetCounts = {
  notionPages: number;
  documents: number;
  compiledWikiPages: number;
  compiledWikiEdges: number;
  knowledgeProfiles?: number;
};

type KnowledgeResetResult = {
  deleted: boolean;
  includeRag: boolean;
  includeCompiledWiki: boolean;
  counts: KnowledgeResetCounts;
};

type KnowledgeProfile = {
  exists: boolean;
  mode: "generated" | "custom";
  generatedProfile: string;
  customProfile: string;
  effectiveProfile: string;
  sourceHash: string;
  indexVersion: string;
  generatedUpdatedAt?: string;
  customUpdatedAt?: string;
  maxCustomProfileChars: number;
};

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => typeof item === "string")) return value.join(" / ");
    return JSON.stringify(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function pickSyncMetadata(event: SyncEvent): Array<[string, unknown]> {
  const metadata = event.metadata ?? {};
  const keysByType: Record<string, string[]> = {
    page_read: ["contentLength", "url"],
    tree_page_scanning: ["parentPageId", "depth"],
    tree_page_found: ["depth", "url", "lastEditedTime"],
    tree_child_found: ["parentPageId", "childPageId", "depth", "relation"],
    tree_page_retry: ["parentPageId", "depth", "attempt", "maxRetries", "nextDelayMs", "name", "message", "cause"],
    tree_page_failed: ["parentPageId", "depth", "name", "message", "code", "status", "cause"],
    page_retry: ["attempt", "maxRetries", "nextDelayMs", "error"],
    page_version_checked: ["existingChunkCount", "contentHash", "embeddingModel", "chunkerVersion", "force", "reason"],
    chunking_start: ["contentLength", "chunkSize", "overlap", "minChunkSize", "maxTokens", "overlapTokens", "chunkerVersion"],
    page_chunked: ["chunkSize", "overlap", "minChunkSize", "maxTokens", "overlapTokens"],
    chunk_sample: ["index", "tokenCount", "kind", "startChar", "endChar", "headingPath", "preview"],
    embedding_start: ["embeddingModel", "expectedDimensions", "batchSize", "totalBatches", "maxRetriesPerBatch"],
    embedding_batch_start: ["batchIndex", "totalBatches", "inputStart", "inputCount", "attempt", "maxAttempts", "idempotencyKey"],
    embedding_batch_retry: ["batchIndex", "totalBatches", "attempt", "maxAttempts", "nextDelayMs", "retryable", "error", "idempotencyKey"],
    embedding_batch_done: ["batchIndex", "totalBatches", "attempt", "providerIndexes", "reordered", "idempotencyKey"],
    embedding_batch_failed: ["batchIndex", "totalBatches", "attempt", "maxAttempts", "retryable", "error", "idempotencyKey"],
    page_embedded: ["embeddingModel", "vectorCount", "dimensions", "totalBatches", "batchSize"],
    db_page_upserted: ["table", "pageUrl", "lastEditedTime"],
    db_old_chunks_deleted: ["table"],
    db_chunks_inserted: ["table", "firstChunkHash"],
    db_atomic_replace_start: ["rpc", "tables", "chunkCount", "firstChunkHash"],
    db_atomic_replace_committed: ["rpc", "pageRowId", "insertedCount", "transaction"],
    batch_done: ["successCount", "failCount", "skippedCount", "createdCount", "updatedCount"],
  };
  const keys = keysByType[event.type] ?? Object.keys(metadata).slice(0, 4);
  return keys
    .filter((key) => metadata[key] !== undefined)
    .map((key) => [key, metadata[key]]);
}

function eventTone(event: SyncEvent) {
  const isError = event.type === "error" || event.type === "page_failed" || event.type === "compile_failed" || event.type === "tree_page_failed" || event.type === "embedding_batch_failed";
  const isDone = event.type === "done" || event.type === "page_done" || event.type === "batch_done" || event.type === "compile_done";
  if (isError) return "text-rose-300";
  if (isDone) return "text-emerald-300";
  if (event.type.includes("retry")) return "text-amber-300";
  if (event.type.includes("chunk")) return "text-cyan-300";
  if (event.type.startsWith("tree_")) return "text-sky-300";
  if (event.type.includes("embedding")) return "text-violet-300";
  if (event.type.startsWith("db_")) return "text-amber-300";
  return "text-zinc-200";
}

export default function KnowledgePage() {
  const [pages, setPages] = useState<KnowledgePage[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPage[]>([]);
  const [wikiEdgeCount, setWikiEdgeCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notionInput, setNotionInput] = useState("");
  const [syncTree, setSyncTree] = useState(true);
  const [syncForce, setSyncForce] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncEvents, setSyncEvents] = useState<SyncEvent[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileForce, setCompileForce] = useState(false);
  const [compileEvents, setCompileEvents] = useState<SyncEvent[]>([]);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [knowledgeProfile, setKnowledgeProfile] = useState<KnowledgeProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState("");
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetIncludeRag, setResetIncludeRag] = useState(true);
  const [resetIncludeCompiledWiki, setResetIncludeCompiledWiki] = useState(true);
  const [resetPreview, setResetPreview] = useState<KnowledgeResetResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const loadPages = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      authFetch("/api/knowledge/pages", { cache: "no-store" }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载失败");
        return data;
      }),
      authFetch("/api/knowledge/wiki", { cache: "no-store" }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载编译知识库失败");
        return data;
      }),
    ])
      .then(async (response) => {
        const [pagesData, wikiData] = response;
        setPages(pagesData.pages ?? []);
        setWikiPages(wikiData.pages ?? []);
        setWikiEdgeCount(wikiData.edgeCount ?? 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const loadKnowledgeProfile = () => {
    setProfileLoading(true);
    setProfileError(null);
    authFetch("/api/knowledge/profile", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载知识库画像失败");
        return data as KnowledgeProfile;
      })
      .then((profile) => {
        setKnowledgeProfile(profile);
        setProfileDraft(profile.customProfile);
      })
      .catch((error) => setProfileError(error.message))
      .finally(() => setProfileLoading(false));
  };

  useEffect(() => {
    loadPages();
    loadKnowledgeProfile();
  }, []);

  async function startSync() {
    const input = notionInput.trim();
    if (!input || syncing) return;

    setSyncing(true);
    setSyncError(null);
    setSyncEvents([]);

    try {
      const response = await authFetch("/api/knowledge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, tree: syncTree, force: syncForce }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "同步启动失败");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SyncEvent;
          setSyncEvents((prev) => [...prev, event]);
          if (event.type === "error") {
            setSyncError(event.message);
          }
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer) as SyncEvent;
        setSyncEvents((prev) => [...prev, event]);
      }

      loadPages();
      loadKnowledgeProfile();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  async function saveKnowledgeProfile() {
    if (!knowledgeProfile?.exists || !profileDraft.trim() || profileSaving) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      const response = await authFetch("/api/knowledge/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customProfile: profileDraft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存知识库画像失败");
      const profile = data as KnowledgeProfile;
      setKnowledgeProfile(profile);
      setProfileDraft(profile.customProfile);
      setProfileNotice("自定义画像已生效");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "保存知识库画像失败");
    } finally {
      setProfileSaving(false);
    }
  }

  async function restoreGeneratedProfile() {
    if (!knowledgeProfile?.customProfile || profileSaving) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      const response = await authFetch("/api/knowledge/profile", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "恢复自动画像失败");
      const profile = data as KnowledgeProfile;
      setKnowledgeProfile(profile);
      setProfileDraft("");
      setProfileNotice("已恢复自动画像");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "恢复自动画像失败");
    } finally {
      setProfileSaving(false);
    }
  }

  async function startCompile() {
    if (compiling) return;

    setCompiling(true);
    setCompileError(null);
    setCompileEvents([]);

    try {
      const response = await authFetch("/api/knowledge/wiki/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: compileForce }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "编译启动失败");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SyncEvent;
          setCompileEvents((prev) => [...prev, event]);
          if (event.type === "error" || event.type === "compile_failed") {
            setCompileError(event.message);
          }
        }
      }

      if (buffer.trim()) {
        setCompileEvents((prev) => [...prev, JSON.parse(buffer) as SyncEvent]);
      }

      loadPages();
      loadKnowledgeProfile();
    } catch (e) {
      setCompileError(e instanceof Error ? e.message : "编译失败");
    } finally {
      setCompiling(false);
    }
  }

  async function runReset(confirm: boolean) {
    if (resetting || (!resetIncludeRag && !resetIncludeCompiledWiki)) return;

    if (confirm) {
      const ok = window.confirm("确认清空选中的知识库数据？这个操作不可撤销。");
      if (!ok) return;
    }

    setResetting(true);
    setResetError(null);

    try {
      const response = await authFetch("/api/knowledge/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm,
          includeRag: resetIncludeRag,
          includeCompiledWiki: resetIncludeCompiledWiki,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "清空知识库失败");
      }

      setResetPreview(data as KnowledgeResetResult);
      if (confirm) {
        loadPages();
        loadKnowledgeProfile();
      }
    } catch (e) {
      setResetError(e instanceof Error ? e.message : "清空知识库失败");
    } finally {
      setResetting(false);
    }
  }

  const summaryEvent = syncEvents.find((event) => event.type === "batch_done");
  const doneEvent = syncEvents.find((event) => event.type === "done");
  const resetTotal = resetPreview
    ? resetPreview.counts.notionPages +
      resetPreview.counts.documents +
      resetPreview.counts.compiledWikiPages +
      resetPreview.counts.compiledWikiEdges +
      (resetPreview.counts.knowledgeProfiles ?? 0)
    : 0;
  const currentTreeEvent = [...syncEvents]
    .reverse()
    .find((event) => event.type === "tree_page_scanning" || event.type === "tree_page_found");
  const currentPageEvent = [...syncEvents]
    .reverse()
    .find((event) => event.type === "page_start" || event.type === "page_read" || event.type === "chunking_start" || event.type === "embedding_start" || event.type.startsWith("db_"));

  return (
    <AuthGate>
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-200">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
          ← 返回对话
        </Link>

        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">知识库</h1>
            <p className="mt-1 text-sm text-slate-500">
              Notion 页面同步、chunk 生成和索引版本。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={loadPages}
              disabled={loading}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
            >
              刷新
            </button>
            <Link
              href="/settings"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
            >
              设置
            </Link>
            <div className="text-sm text-slate-500">{pages.length} 个页面</div>
          </div>
        </div>

        <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-3">
            <h2 className="text-sm font-medium text-zinc-100">同步控制台</h2>
          </div>
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <label className="text-xs text-zinc-500">Notion 页面链接或 ID</label>
              <div className="mt-2 flex gap-2">
                <input
                  value={notionInput}
                  onChange={(event) => setNotionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") startSync();
                  }}
                  placeholder="https://app.notion.com/p/..."
                  className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-700"
                  disabled={syncing}
                />
                <button
                  type="button"
                  onClick={startSync}
                  disabled={syncing || !notionInput.trim()}
                  className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  {syncing ? "同步中" : "开始同步"}
                </button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
                <input
                  type="checkbox"
                  checked={syncTree}
                  onChange={(event) => setSyncTree(event.target.checked)}
                  disabled={syncing}
                  className="h-4 w-4 accent-cyan-600"
                />
                递归同步子页面
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                <input
                  type="checkbox"
                  checked={syncForce}
                  onChange={(event) => setSyncForce(event.target.checked)}
                  disabled={syncing}
                  className="h-4 w-4 accent-cyan-600"
                />
                强制刷新 chunks 和向量
              </label>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-zinc-500">事件</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{syncEvents.length}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-zinc-500">页面</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">
                  {summaryEvent?.totalPages ?? "-"}
                </div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-zinc-500">Chunks</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">
                  {summaryEvent?.chunksCount ?? "-"}
                </div>
              </div>
            </div>
          </div>

          {(syncing || currentTreeEvent || currentPageEvent) && (
            <div className="border-t border-zinc-800 px-4 py-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <div className="text-xs text-zinc-500">当前扫描</div>
                  <div className="mt-1 truncate text-sm font-medium text-sky-300">
                    {currentTreeEvent?.pageTitle ?? currentTreeEvent?.pageId ?? "等待页面树扫描"}
                  </div>
                  {currentTreeEvent?.metadata?.depth !== undefined && (
                    <div className="mt-1 text-xs text-zinc-500">
                      depth: {String(currentTreeEvent.metadata.depth)}
                    </div>
                  )}
                </div>
                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <div className="text-xs text-zinc-500">当前同步</div>
                  <div className="mt-1 truncate text-sm font-medium text-cyan-300">
                    {currentPageEvent?.pageTitle ?? currentPageEvent?.pageId ?? "等待 chunk 同步"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {currentPageEvent?.type ?? "-"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {(syncEvents.length > 0 || syncError) && (
            <div className="border-t border-zinc-800 px-4 py-3">
              {syncError && (
                <div className="mb-3 rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                  {syncError}
                </div>
              )}
              <div className="max-h-80 space-y-2 overflow-auto pr-1">
                {syncEvents.map((event, index) => {
                  const metaEntries = pickSyncMetadata(event);
                  return (
                    <div
                      key={`${event.type}-${index}`}
                      className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                    >
                      <div className="font-mono text-xs text-zinc-500">
                        {event.at ? new Date(event.at).toLocaleTimeString() : "--:--:--"}
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-medium ${eventTone(event)}`}>
                            {event.message}
                          </span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">
                            {event.type}
                          </span>
                        </div>
                        {(event.pageTitle || event.pageId || event.chunksCount !== undefined) && (
                          <div className="mt-1 truncate text-xs text-zinc-500">
                            {event.pageTitle ?? event.pageId}
                            {event.chunksCount !== undefined ? ` · ${event.chunksCount} chunks` : ""}
                            {event.status ? ` · ${event.status}` : ""}
                          </div>
                        )}
                        {metaEntries.length > 0 && (
                          <div className="mt-2 grid gap-1 text-xs md:grid-cols-2">
                            {metaEntries.map(([key, value]) => {
                              const isPreview = key === "preview";
                              return (
                                <div
                                  key={key}
                                  className={isPreview ? "md:col-span-2" : ""}
                                >
                                  <span className="text-zinc-600">{key}: </span>
                                  <span className={isPreview ? "text-zinc-300" : "font-mono text-zinc-400"}>
                                    {formatMetaValue(value)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {syncing && (
                  <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-500">
                    等待下一步...
                  </div>
                )}
                {doneEvent && !syncing && (
                  <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
                    同步完成，页面列表已刷新。
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950">
          <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-zinc-100">LLM 编译知识库</h2>
              <p className="mt-1 text-xs text-zinc-500">把 raw chunks 编译成结构化 wiki 页面和概念关系。</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-zinc-400">
                <input
                  type="checkbox"
                  checked={compileForce}
                  onChange={(event) => setCompileForce(event.target.checked)}
                  disabled={compiling}
                  className="h-4 w-4 accent-cyan-600"
                />
                强制重编译
              </label>
              <button
                type="button"
                onClick={startCompile}
                disabled={compiling || pages.length === 0}
                className="rounded-md bg-violet-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {compiling ? "编译中" : "编译 Wiki"}
              </button>
            </div>
          </div>
          <div className="grid gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="grid grid-cols-2 gap-2 text-center text-xs lg:grid-cols-1">
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-zinc-500">Wiki 页面</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{wikiPages.length}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-zinc-500">概念关系</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">{wikiEdgeCount}</div>
              </div>
            </div>

            <div>
              {compileError && (
                <div className="mb-3 rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                  {compileError}
                </div>
              )}
              {compileEvents.length > 0 ? (
                <div className="max-h-56 space-y-2 overflow-auto pr-1">
                  {compileEvents.map((event, index) => {
                    const isError = event.type === "error" || event.type === "compile_failed";
                    const isDone = event.type === "done" || event.type === "compile_done";
                    return (
                      <div
                        key={`${event.type}-${index}`}
                        className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                      >
                        <div className="font-mono text-xs text-zinc-500">
                          {event.at ? new Date(event.at).toLocaleTimeString() : "--:--:--"}
                        </div>
                        <div className={isError ? "text-rose-300" : isDone ? "text-emerald-300" : "text-zinc-200"}>
                          {event.message}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-6 text-center text-sm text-zinc-500">
                  编译后会在这里显示实时事件。
                </div>
              )}
            </div>
          </div>

          {wikiPages.length > 0 && (
            <div className="border-t border-zinc-800 px-4 py-3">
              <div className="grid gap-3 md:grid-cols-2">
                {wikiPages.slice(0, 6).map((page) => (
                  <div key={page.slug} className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="text-sm font-medium text-zinc-100">{page.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-zinc-500">{page.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(page.concepts ?? []).slice(0, 4).map((concept) => (
                        <span key={concept} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                          {concept}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-zinc-100">知识库画像</h2>
              <p className="mt-1 text-xs text-zinc-500">检索路由使用的知识范围。</p>
            </div>
            {knowledgeProfile?.exists && (
              <span className={`rounded px-2 py-1 text-xs font-medium ${
                knowledgeProfile.mode === "custom"
                  ? "bg-cyan-950 text-cyan-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}>
                {knowledgeProfile.mode === "custom" ? "自定义生效" : "自动生成"}
              </span>
            )}
          </div>

          {profileLoading ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">加载画像...</div>
          ) : profileError && !knowledgeProfile ? (
            <div className="px-4 py-4 text-sm text-rose-300">{profileError}</div>
          ) : knowledgeProfile?.exists ? (
            <>
              <div className="border-b border-zinc-800 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-500">当前生效</span>
                  <span className="font-mono text-[11px] text-zinc-600">
                    {knowledgeProfile.indexVersion.slice(0, 12)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-200">
                  {knowledgeProfile.effectiveProfile}
                </p>
              </div>

              <div className="grid md:grid-cols-2">
                <div className="border-b border-zinc-800 p-4 md:border-b-0 md:border-r">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="custom-knowledge-profile" className="text-xs font-medium text-zinc-400">
                      用户覆盖
                    </label>
                    <span className="text-xs text-zinc-600">
                      {profileDraft.length}/{knowledgeProfile.maxCustomProfileChars}
                    </span>
                  </div>
                  <textarea
                    id="custom-knowledge-profile"
                    value={profileDraft}
                    onChange={(event) => {
                      setProfileDraft(event.target.value);
                      setProfileNotice(null);
                      setProfileError(null);
                    }}
                    maxLength={knowledgeProfile.maxCustomProfileChars}
                    placeholder="输入自定义知识范围"
                    className="mt-2 min-h-32 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-700"
                    disabled={profileSaving}
                  />
                  <div className="mt-3 flex min-h-9 flex-wrap items-center justify-between gap-2">
                    <div className="text-xs">
                      {profileError && <span className="text-rose-300">{profileError}</span>}
                      {profileNotice && <span className="text-emerald-300">{profileNotice}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={restoreGeneratedProfile}
                        disabled={profileSaving || !knowledgeProfile.customProfile}
                        className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        恢复自动
                      </button>
                      <button
                        type="button"
                        onClick={saveKnowledgeProfile}
                        disabled={
                          profileSaving
                          || !profileDraft.trim()
                          || profileDraft.trim() === knowledgeProfile.customProfile
                        }
                        className="inline-flex items-center gap-2 rounded-md bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                      >
                        <Save className="h-4 w-4" aria-hidden="true" />
                        {profileSaving ? "保存中" : "保存"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-zinc-400">系统生成</span>
                    <span className="text-[11px] text-zinc-600">
                      {knowledgeProfile.generatedUpdatedAt
                        ? new Date(knowledgeProfile.generatedUpdatedAt).toLocaleString()
                        : "-"}
                    </span>
                  </div>
                  <p className="mt-2 min-h-32 whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-6 text-zinc-400">
                    {knowledgeProfile.generatedProfile || "暂无自动画像"}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              编译知识库后生成画像。
            </div>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-rose-950 bg-zinc-950">
          <div className="flex flex-col gap-3 border-b border-rose-950/80 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-medium text-rose-100">知识库产物管理</h2>
              <p className="mt-1 text-xs text-zinc-500">
                清空 raw RAG 或已编译 Wiki 产物；编译能力在上方 Wiki 面板执行。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => runReset(false)}
                disabled={resetting || (!resetIncludeRag && !resetIncludeCompiledWiki)}
                className="rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
              >
                {resetting ? "处理中" : "预览清空"}
              </button>
              <button
                type="button"
                onClick={() => runReset(true)}
                disabled={resetting || syncing || compiling || (!resetIncludeRag && !resetIncludeCompiledWiki)}
                className="rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                确认清空
              </button>
            </div>
          </div>

          <div className="grid gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-zinc-400">
                <input
                  type="checkbox"
                  checked={resetIncludeRag}
                  onChange={(event) => {
                    setResetIncludeRag(event.target.checked);
                    setResetPreview(null);
                  }}
                  disabled={resetting}
                  className="h-4 w-4 accent-rose-600"
                />
                Raw RAG 页面和 chunks
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-400">
                <input
                  type="checkbox"
                  checked={resetIncludeCompiledWiki}
                  onChange={(event) => {
                    setResetIncludeCompiledWiki(event.target.checked);
                    setResetPreview(null);
                  }}
                  disabled={resetting}
                  className="h-4 w-4 accent-rose-600"
                />
                编译 Wiki 页面和关系
              </label>
            </div>

            <div>
              {resetError && (
                <div className="mb-3 rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                  {resetError}
                </div>
              )}

              {resetPreview ? (
                <div className="grid gap-2 text-center text-xs sm:grid-cols-4">
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                    <div className="text-zinc-500">Raw 页面</div>
                    <div className="mt-1 text-lg font-semibold text-zinc-100">
                      {resetPreview.counts.notionPages}
                    </div>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                    <div className="text-zinc-500">Chunks</div>
                    <div className="mt-1 text-lg font-semibold text-zinc-100">
                      {resetPreview.counts.documents}
                    </div>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                    <div className="text-zinc-500">Wiki 页面</div>
                    <div className="mt-1 text-lg font-semibold text-zinc-100">
                      {resetPreview.counts.compiledWikiPages}
                    </div>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                    <div className="text-zinc-500">关系</div>
                    <div className="mt-1 text-lg font-semibold text-zinc-100">
                      {resetPreview.counts.compiledWikiEdges}
                    </div>
                  </div>
                  <div className={`rounded-md border px-3 py-2 text-left text-sm sm:col-span-4 ${
                    resetPreview.deleted
                      ? "border-emerald-900 bg-emerald-950/30 text-emerald-300"
                      : "border-amber-900 bg-amber-950/20 text-amber-300"
                  }`}>
                    {resetPreview.deleted
                      ? `已清空 ${resetTotal} 条知识库记录。`
                      : `预览会清空 ${resetTotal} 条知识库记录，确认后才会删除。`}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-6 text-center text-sm text-zinc-500">
                  先预览将要清空的数据范围。
                </div>
              )}
            </div>
          </div>
        </section>

        {loading && <div className="mt-8 text-slate-500">加载中...</div>}
        {error && (
          <div className="mt-8 rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="mt-6 overflow-hidden rounded-lg border border-slate-800">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">页面</th>
                  <th className="px-4 py-3 font-medium">Chunks</th>
                  <th className="px-4 py-3 font-medium">同步时间</th>
                  <th className="px-4 py-3 font-medium">索引版本</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pages.map((page) => (
                  <tr key={page.page_id} className="bg-slate-950/60">
                    <td className="px-4 py-3">
                      <a
                        href={page.page_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-100 hover:text-sky-300"
                      >
                        {page.page_title?.trim() || "Untitled"}
                      </a>
                      <div className="mt-1 font-mono text-xs text-slate-600">
                        {page.page_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{page.chunk_count}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {page.last_synced_at
                        ? new Date(page.last_synced_at).toLocaleString()
                        : "-"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      <div>{page.metadata?.embedding_model ?? "-"}</div>
                      <div>{page.metadata?.chunker_version ?? "-"}</div>
                    </td>
                  </tr>
                ))}
                {pages.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                      暂无已同步页面
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    </AuthGate>
  );
}
