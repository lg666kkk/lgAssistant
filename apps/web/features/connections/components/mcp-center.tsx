"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Plug,
  RefreshCw,
  Save,
  Trash2,
  X,
  LoaderCircle,
  SquareTerminal,
  ShieldCheck,
} from "lucide-react";
import type {
  McpServerView,
  McpServerDraft,
  McpDiscoveryResult,
} from "@repo/contracts";
import { authFetch } from "@web/lib/auth/client";
import { useAuth } from "@web/lib/auth/use-auth";

const field =
  "h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500 disabled:opacity-50";
const button =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40";
const emptyDraft = (): McpServerDraft => ({
  name: "",
  url: "",
  token: "",
  enabled: false,
  tools: [],
});

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await authFetch(url, {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试");
  return data;
}

export function McpCenter() {
  const { user, requireLogin } = useAuth();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageReady, setStorageReady] = useState(true);
  const [editor, setEditor] = useState<{
    server?: McpServerView;
    draft: McpServerDraft;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testNotice, setTestNotice] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!user) {
      setServers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api<{
        servers: McpServerView[];
        storageReady: boolean;
      }>("/api/mcp/servers");
      setServers(data.servers);
      setStorageReady(data.storageReady);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = (server?: McpServerView) => {
    setEditor({
      server,
      draft: server
        ? {
            name: server.name,
            url: server.url,
            enabled: server.enabled,
            tools: server.tools.map((tool) => ({ ...tool })),
            token: "",
          }
        : emptyDraft(),
    });
    setError("");
    setNotice("");
    setTestNotice("");
    setDeleting(null);
  };
  const patch = (value: Partial<McpServerDraft>) => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...value } } : current,
    );
    setError("");
    if ("url" in value || "token" in value || "clearToken" in value)
      setTestNotice("");
  };
  const test = async () => {
    if (!editor || !requireLogin()) return;
    setTesting(true);
    setError("");
    setTestNotice("");
    try {
      const data = await api<McpDiscoveryResult>("/api/mcp/discover", "POST", {
        id: editor.server?.id,
        url: editor.draft.url,
        token: editor.draft.token || undefined,
        clearToken: editor.draft.clearToken,
      });
      const previous = new Map(
        editor.draft.tools.map((tool) => [tool.name, tool]),
      );
      patch({
        tools: data.tools.map((tool) => ({
          ...tool,
          enabled: previous.get(tool.name)?.enabled ?? false,
          approval: previous.get(tool.name)?.approval ?? "always",
        })),
      });
      setTestNotice(
        `连接成功 · ${data.latencyMs} ms · 发现 ${data.tools.length} 个工具。请选择允许使用的工具。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    if (!editor || !requireLogin()) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ server: McpServerView }>(
        editor.server
          ? `/api/mcp/servers/${editor.server.id}`
          : "/api/mcp/servers",
        editor.server ? "PATCH" : "POST",
        { ...editor.draft, token: editor.draft.token || undefined },
      );
      setServers((current) =>
        editor.server
          ? current.map((server) =>
              server.id === data.server.id ? data.server : server,
            )
          : [...current, data.server],
      );
      setEditor(null);
      setNotice("服务已保存，下一轮对话将使用新的配置。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/mcp/servers/${id}`, "DELETE");
      setServers((current) => current.filter((server) => server.id !== id));
      setDeleting(null);
      setNotice("服务已删除。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">MCP</h2>
            <p className="mt-1 text-sm text-slate-500">
              连接外部服务，为助手添加新的工具。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              aria-label="刷新 MCP 服务"
              className={button}
              onClick={() => {
                setError("");
                void load();
              }}
              disabled={loading || busy || testing}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
              data-guest-browse
              onClick={() => open()}
              disabled={busy || testing || !storageReady}
            >
              <Plus className="h-4 w-4" />
              添加服务
            </button>
          </div>
        </header>
        {!storageReady && (
          <div
            role="status"
            className="mt-5 rounded-lg border border-amber-900 bg-amber-950/20 p-4 text-sm text-amber-200"
          >
            MCP 配置存储尚未初始化，请联系管理员完成数据库更新。
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/20 p-3 text-sm text-emerald-300"
          >
            {notice}
          </div>
        )}
        {editor ? (
          <section
            aria-label={editor.server ? "编辑 MCP 服务" : "添加 MCP 服务"}
            className="mt-6 rounded-xl border border-slate-700 bg-slate-900/30 p-5"
          >
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-medium">
                {editor.server ? "编辑服务" : "添加服务"}
              </h3>
              <button
                data-guest-browse
                aria-label="关闭服务编辑"
                className={button}
                disabled={busy || testing}
                onClick={() => {
                  setEditor(null);
                  setError("");
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <fieldset disabled={busy || testing} className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-slate-400">
                  <span>服务名称</span>
                  <input
                    autoFocus
                    className={field}
                    value={editor.draft.name}
                    maxLength={80}
                    placeholder="例如：团队知识库"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
                <label className="space-y-2 text-sm text-slate-400">
                  <span>连接方式</span>
                  <input className={field} value="Streamable HTTP" readOnly />
                </label>
              </div>
              <label className="block space-y-2 text-sm text-slate-400">
                <span>服务地址</span>
                <input
                  type="url"
                  className={field}
                  value={editor.draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </label>
              <label className="block space-y-2 text-sm text-slate-400">
                <span>
                  Bearer Token{" "}
                  <span className="text-slate-500">
                    （可选
                    {editor.server?.tokenConfigured
                      ? "，已保存；留空保持原值"
                      : ""}
                    ）
                  </span>
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={field}
                  value={editor.draft.token ?? ""}
                  placeholder="输入服务提供的 Token"
                  onChange={(e) =>
                    patch({ token: e.target.value, clearToken: false })
                  }
                />
              </label>
              {editor.server?.tokenConfigured && (
                <label className="flex items-center gap-2 text-sm text-slate-400">
                  <input
                    type="checkbox"
                    className="accent-cyan-500"
                    checked={editor.draft.clearToken ?? false}
                    onChange={(e) =>
                      patch({ clearToken: e.target.checked, token: "" })
                    }
                  />
                  清除已保存的 Token
                </label>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className={button}
                  disabled={!editor.draft.url.trim()}
                  onClick={() => void test()}
                >
                  {testing ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="h-4 w-4" />
                  )}
                  测试连接并发现工具
                </button>
                <span className="text-xs text-slate-500">
                  仅获取工具列表，不执行工具。
                </span>
              </div>
              {testNotice && (
                <p role="status" className="text-sm text-emerald-400">
                  {testNotice}
                </p>
              )}
              <div className="border-t border-slate-800 pt-5">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">允许使用的工具</h4>
                  <span className="text-xs text-slate-500">
                    已选择{" "}
                    {editor.draft.tools.filter((tool) => tool.enabled).length} /
                    32
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  默认每次调用都需要确认。仅为已核实的只读工具选择“只读免确认”。
                </p>
                {editor.draft.tools.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">
                    测试连接后，选择助手可以使用的工具。
                  </p>
                ) : (
                  <div className="mt-4 max-h-80 divide-y divide-slate-800 overflow-y-auto">
                    {editor.draft.tools.map((tool, index) => (
                      <div
                        key={tool.name}
                        className="flex flex-wrap items-start gap-3 py-3"
                      >
                        <input
                          aria-label={`允许工具 ${tool.name}`}
                          type="checkbox"
                          checked={tool.enabled}
                          className="mt-1 accent-cyan-500"
                          disabled={
                            !tool.enabled &&
                            editor.draft.tools.filter((item) => item.enabled)
                              .length >= 32
                          }
                          onChange={(e) =>
                            patch({
                              tools: editor.draft.tools.map((item, i) =>
                                i === index
                                  ? { ...item, enabled: e.target.checked }
                                  : item,
                              ),
                            })
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="break-all font-mono text-sm text-slate-200">
                            {tool.name}
                          </div>
                          <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                            {tool.description || "暂无描述"}
                          </p>
                        </div>
                        <select
                          aria-label={`${tool.name} 调用权限`}
                          className={`${field} !w-36`}
                          value={tool.approval}
                          onChange={(e) =>
                            patch({
                              tools: editor.draft.tools.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      approval: e.target.value as
                                        | "always"
                                        | "read-only",
                                    }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option value="always">每次确认</option>
                          <option value="read-only">只读免确认</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 pt-5">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-cyan-500"
                    checked={editor.draft.enabled}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                  />
                  在对话中启用此服务
                </label>
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-cyan-500 px-5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
                  disabled={
                    !storageReady ||
                    !editor.draft.name.trim() ||
                    !editor.draft.url.trim()
                  }
                  onClick={() => void save()}
                >
                  {busy ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存服务
                </button>
              </div>
            </fieldset>
          </section>
        ) : loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-slate-500">
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />
            加载 MCP 服务
          </div>
        ) : servers.length === 0 ? (
          <div className="my-8 flex flex-col items-center rounded-xl border border-dashed border-slate-800 px-5 py-16 text-center">
            <div className="mb-5 rounded-2xl border border-slate-800 bg-slate-900 p-4 text-cyan-300">
              <SquareTerminal className="h-7 w-7" />
            </div>
            <h3 className="font-medium text-slate-200">
              连接你的第一个 MCP 服务
            </h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
              添加服务地址，发现可用工具，让助手在对话中使用你的外部服务。
            </p>
            <button
              className={`${button} mt-6`}
              disabled={!storageReady}
              data-guest-browse
              onClick={() => open()}
            >
              <Plus className="h-4 w-4" />
              添加服务
            </button>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {servers.map((server) => (
              <article
                key={server.id}
                className="rounded-xl border border-slate-800 bg-slate-900/30 p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-lg bg-slate-800 p-2.5 text-cyan-300">
                      <Plug className="h-5 w-5" />
                    </span>
                    <h3 className="truncate font-medium">{server.name}</h3>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${server.enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-500"}`}
                  >
                    {server.enabled ? "已启用" : "未启用"}
                  </span>
                </div>
                <p className="mt-4 break-all text-sm text-slate-500">
                  {server.url}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="rounded bg-slate-800 px-2 py-1">
                    Streamable HTTP
                  </span>
                  <span className="rounded bg-slate-800 px-2 py-1">
                    {server.tools.filter((tool) => tool.enabled).length}{" "}
                    个允许工具
                  </span>
                  <span className="rounded bg-slate-800 px-2 py-1">
                    {server.tokenConfigured ? "Token 已配置" : "无 Token"}
                  </span>
                </div>
                <details
                  className="mt-4 text-sm text-slate-400"
                  data-guest-browse
                >
                  <summary className="cursor-pointer">查看工具</summary>
                  <ul className="mt-3 space-y-2">
                    {server.tools.map((tool) => (
                      <li
                        key={tool.name}
                        className="flex justify-between gap-3 text-xs"
                      >
                        <span className="break-all font-mono">{tool.name}</span>
                        <span className="shrink-0 text-slate-500">
                          {!tool.enabled
                            ? "未允许"
                            : tool.approval === "always"
                              ? "每次确认"
                              : "只读免确认"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                  {deleting === server.id ? (
                    <>
                      <span className="text-xs text-rose-300">
                        确定删除此服务？
                      </span>
                      <div className="flex gap-2">
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => setDeleting(null)}
                        >
                          取消
                        </button>
                        <button
                          className={`${button} text-rose-300`}
                          disabled={busy}
                          onClick={() => void remove(server.id)}
                        >
                          确认删除
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => open(server)}
                      >
                        配置服务
                      </button>
                      <button
                        aria-label={`删除 ${server.name}`}
                        className={`${button} text-slate-500`}
                        disabled={busy}
                        onClick={() => setDeleting(server.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-6 flex items-center gap-2 text-xs leading-5 text-slate-500">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          个人服务仅供当前账户使用，Token 加密保存。启用状态不代表当前连接健康。
        </p>
      </div>
    </div>
  );
}
