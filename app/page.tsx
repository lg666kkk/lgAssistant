"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useChatManager } from "@/hooks/use-chat-manager";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./components/chat-input";
import type { ModelUsageEventData } from "@/lib/agent/runtime/events";
import { defaultChatModel, type ChatModelId } from "@/lib/agent/models";
import { AuthGate } from "@/lib/auth/auth-gate";
import { useAuth } from "@/lib/auth/use-auth";

function formatCompactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function summarizeUsages(usages?: ModelUsageEventData[]) {
  if (!usages?.length) return null;
  const total = usages.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      cacheHitTokens: sum.cacheHitTokens + usage.cacheHitTokens,
      cacheMissTokens: sum.cacheMissTokens + usage.cacheMissTokens,
      cacheCreationTokens:
        sum.cacheCreationTokens + usage.cacheCreationTokens,
      estimatedCostCny: sum.estimatedCostCny + usage.estimatedCostCny,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostCny: 0,
    },
  );
  const measuredInput = total.cacheHitTokens + total.cacheMissTokens;
  return {
    ...total,
    cacheHitRate:
      measuredInput > 0 ? total.cacheHitTokens / measuredInput : 0,
  };
}

function MessageUsageBar({ usages }: { usages?: ModelUsageEventData[] }) {
  const usage = summarizeUsages(usages);
  if (!usage) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-700/70 pt-2 text-[11px] text-slate-500">
      <span title="真实总 tokens">
        token {formatCompactNumber(usage.totalTokens)}
      </span>
      <span title="输入 tokens">
        输入 {formatCompactNumber(usage.inputTokens)}
      </span>
      <span title="输出 tokens">
        输出 {formatCompactNumber(usage.outputTokens)}
      </span>
      {(usage.cacheHitTokens > 0 || usage.cacheMissTokens > 0) && (
        <span title="DeepSeek prompt cache 命中率">
          缓存命中 {(usage.cacheHitRate * 100).toFixed(1)}%
        </span>
      )}
      {usage.cacheCreationTokens > 0 && (
        <span title="缓存创建 tokens">
          缓存创建 {formatCompactNumber(usage.cacheCreationTokens)}
        </span>
      )}
      <span title="按模型价格估算的本次费用">
        约 ¥{usage.estimatedCostCny.toFixed(4)}
      </span>
    </div>
  );
}

function maskEmail(email?: string | null) {
  if (!email) return "未登录";
  const [name, domain] = email.split("@");
  if (!domain) return email;
  if (name.length <= 2) return `${name[0] ?? ""}***@${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

export default function Home() {
  const { user, supabase } = useAuth();
  const {
    sessions,
    activeId,
    activeSession,
    createSession,
    moveSessionToTop,
    switchSession,
    deleteSession,
    rerender,
    loading: sessionsLoading,
  } = useChatManager();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [knowledgeSearchEnabled, setKnowledgeSearchEnabled] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [confirmingToolKey, setConfirmingToolKey] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] =
    useState<ChatModelId>(defaultChatModel);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  const { messages, loading, streaming, error } = activeSession || {};
  const lastMessageContent = messages?.length
    ? messages[messages.length - 1]?.content
    : "";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, lastMessageContent]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [accountMenuOpen]);

  const handleSend = async () => {
    if (!input.trim() || loading || !activeSession) return;
    const text = input;
    setInput("");
    moveSessionToTop(activeSession.id);
    requestAnimationFrame(() => inputRef.current?.focus());
    await activeSession.send(text, rerender, {
      webSearchEnabled,
      knowledgeSearchEnabled,
      model: selectedModel,
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleStop = () => {
    activeSession?.abort();
  };

  const handleSwitchSession = (id: string) => {
    switchSession(id);
    setInput("");
    setAccountMenuOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSignOut = async () => {
    setAccountMenuOpen(false);
    await supabase.auth.signOut();
  };

  // 加载中状态
  if (sessionsLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="text-slate-400">加载中...</div>
      </div>
    );
  }

  return (
    <AuthGate>
    <div className="flex h-screen bg-slate-950">
      {/* 侧边栏 */}
      <aside
        className={`flex flex-col border-r border-slate-800 bg-slate-900 transition-all duration-300 ${
          sidebarOpen ? "w-64" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        <div className="p-4">
          <button
            onClick={createSession}
            className="w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            + 新对话
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => handleSwitchSession(session.id)}
              className={`group flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm cursor-pointer transition-colors whitespace-nowrap ${
                session.id === activeId
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  session.isRunning ? "bg-emerald-400" : "bg-slate-700"
                }`}
                title={session.isRunning ? "运行中" : "空闲"}
              />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.isRunning && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    session.abort();
                    rerender();
                  }}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-red-300 opacity-80 transition-opacity hover:bg-red-950/50 hover:text-red-200 group-hover:opacity-100"
                  title="停止这个会话"
                >
                  停止
                </button>
              )}
              {sessions.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(session.id);
                  }}
                  className="shrink-0 text-slate-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  title="删除会话"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </nav>
        <div ref={accountMenuRef} className="relative border-t border-slate-800 p-3">
          {accountMenuOpen && (
            <div className="absolute bottom-full left-3 mb-2 w-[232px] rounded-2xl border border-slate-700 bg-slate-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur">
              <Link
                href="/knowledge"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15Z" />
                  </svg>
                </span>
                <span>知识库</span>
              </Link>
              <Link
                href="/traces"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 3v18h18" />
                    <path d="M7 15l3-3 3 2 4-6" />
                    <path d="M17 8h3v3" />
                  </svg>
                </span>
                <span>Trace 观测</span>
              </Link>
              <Link
                href="/usage"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2v20" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </span>
                <span>用量统计</span>
              </Link>
              <Link
                href="/schedule"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </span>
                <span>定时任务</span>
              </Link>
              <Link
                href="/settings"
                target="_blank"
                rel="noreferrer"
                onClick={() => setAccountMenuOpen(false)}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
                  </svg>
                </span>
                <span>系统设置</span>
              </Link>
              <button
                type="button"
                onClick={handleSignOut}
                className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <path d="M16 17l5-5-5-5" />
                    <path d="M21 12H9" />
                  </svg>
                </span>
                <span>退出登录</span>
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setAccountMenuOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-300">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 21a8 8 0 0 0-16 0" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {maskEmail(user?.email)}
            </span>
            <span className="text-lg leading-none text-slate-500">...</span>
          </button>
        </div>
      </aside>

      {/* 主区域 */}
      <main className="flex flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold text-white">LG的个人知识助手</h1>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {messages && messages.length === 0 && (
              <p className="mt-20 text-center text-slate-500">
                发送一条消息开始对话
              </p>
            )}
            {messages &&
              messages.map((msg, i) => {
                const isStreaming =
                  streaming &&
                  msg.role === "assistant" &&
                  i === messages.length - 1;
                return (
                  <div
                    key={i}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "max-w-[78%] bg-cyan-600 text-white"
                        : "w-full bg-slate-800 text-slate-200"
                    } ${isStreaming ? "streaming-msg" : ""}`}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h2({ children }) {
                          return (
                            <h2 className="mb-2 text-base font-semibold text-white">
                              {children}
                            </h2>
                          );
                        },
                        p({ children }) {
                          return <p className="mb-2 last:mb-0">{children}</p>;
                        },
                        ul({ children }) {
                          return (
                            <ul className="my-2 list-disc space-y-1 pl-5">
                              {children}
                            </ul>
                          );
                        },
                        ol({ children }) {
                          return (
                            <ol className="my-2 list-decimal space-y-2 pl-5">
                              {children}
                            </ol>
                          );
                        },
                        li({ children }) {
                          return (
                            <li className="leading-relaxed">{children}</li>
                          );
                        },
                        a({ href, children }) {
                          return (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="break-all text-cyan-300 underline decoration-cyan-500/60 underline-offset-2 hover:text-cyan-200"
                            >
                              {children}
                            </a>
                          );
                        },
                        table({ children }) {
                          return (
                            <table className="my-3 w-full border-collapse overflow-hidden rounded-lg border border-slate-700 text-left text-sm">
                              {children}
                            </table>
                          );
                        },
                        thead({ children }) {
                          return (
                            <thead className="bg-slate-900/80">
                              {children}
                            </thead>
                          );
                        },
                        tbody({ children }) {
                          return (
                            <tbody className="divide-y divide-slate-700">
                              {children}
                            </tbody>
                          );
                        },
                        tr({ children }) {
                          return (
                            <tr className="border-b border-slate-700 last:border-b-0">
                              {children}
                            </tr>
                          );
                        },
                        th({ children }) {
                          return (
                            <th className="border border-slate-700 px-3 py-2 font-semibold text-slate-300">
                              {children}
                            </th>
                          );
                        },
                        td({ children }) {
                          return (
                            <td className="border border-slate-700 px-3 py-2 align-top text-slate-200">
                              {children}
                            </td>
                          );
                        },
                        code({ className, children }) {
                          const language = className?.replace("language-", "");
                          if (!language) {
                            return (
                              <code className="bg-slate-700 px-1.5 py-0.5 rounded text-sm">
                                {children}
                              </code>
                            );
                          }
                          return (
                            <SyntaxHighlighter
                              language={language}
                              style={oneDark}
                            >
                              {String(children).replace(/\n$/, "")}
                            </SyntaxHighlighter>
                          );
                        },
                      }}
                    >
                      {msg.content || (loading ? "思考中..." : "")}
                    </ReactMarkdown>
                    {/* 显示工具调用 */}
                    {msg.role === "assistant" &&
                      msg.toolCalls &&
                      msg.toolCalls.length > 0 && (
                        <div className="mt-3 rounded-lg border border-cyan-800 bg-cyan-950/30">
                          <div className="mb-2 text-xs font-medium text-cyan-300">
                            🔧 工具调用
                          </div>
                          <div className="space-y-2">
                            {msg.toolCalls.map((toolCall, idx) => (
                              <div key={idx} className="text-xs text-slate-300">
                                <div>
                                  <span className="text-slate-400">工具：</span>
                                  <span className="font-mono text-cyan-300">
                                    {toolCall.name}
                                  </span>
                                </div>
                                {/* {toolCall.input !== undefined && (
                                  <div>
                                    <span className="text-slate-400">
                                      输入：
                                    </span>
                                    <code className="rounded bg-slate-900/60 px-1.5 py-0.5 font-mono text-cyan-100">
                                      {JSON.stringify(toolCall.input)}
                                    </code>
                                  </div>
                                )} */}
                                <div>
                                  <span className="text-slate-400">状态：</span>
                                  <span
                                    className={
                                      String(toolCall.metadata?.status) ===
                                      "pending_confirmation"
                                        ? "font-medium text-amber-300"
                                        : String(toolCall.metadata?.status) ===
                                            "confirmed"
                                          ? "font-medium text-emerald-300"
                                          : toolCall.ok
                                            ? "font-medium text-emerald-400"
                                            : "font-medium text-red-400"
                                    }
                                  >
                                    {String(toolCall.metadata?.status) ===
                                    "pending_confirmation"
                                      ? "待确认"
                                      : String(toolCall.metadata?.status) ===
                                          "confirmed"
                                        ? "已确认执行"
                                        : toolCall.ok
                                          ? "成功"
                                          : "失败"}
                                  </span>
                                </div>
                                <div>
                                  {String(toolCall.metadata?.status) ===
                                    "pending_confirmation" && (
                                    <div className="mt-2 flex gap-2">
                                      <button
                                        type="button"
                                        disabled={confirmingToolKey === `${i}:${idx}`}
                                        className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                                        onClick={async () => {
                                          const key = `${i}:${idx}`;
                                          setConfirmingToolKey(key);
                                          try {
                                            await activeSession?.confirmToolCall(
                                              i,
                                              idx,
                                            );
                                            rerender();
                                          } finally {
                                            setConfirmingToolKey(null);
                                          }
                                        }}
                                      >
                                        {confirmingToolKey === `${i}:${idx}`
                                          ? "执行中..."
                                          : "确认执行"}
                                      </button>
                                      <button
                                        onClick={async () => {
                                          if (confirmingToolKey) return;
                                          await activeSession?.cancelToolCall(
                                            i,
                                            idx,
                                          );
                                          rerender();
                                        }}
                                        type="button"
                                        className="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600"
                                      >
                                        取消
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    {/* 显示引用来源 */}
                    {msg.role === "assistant" &&
                      msg.sources &&
                      msg.sources.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-700">
                          <div className="text-xs text-slate-400 mb-2">
                            📚 参考来源
                          </div>
                          <div className="space-y-1.5">
                            {msg.sources.map((source, idx) => (
                              <a
                                key={idx}
                                href={source.pageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                              >
                                <span className="font-medium hover:underline">
                                  [{idx + 1}] {source.title}
                                </span>
                                <span className="text-slate-500 ml-1">
                                  (相似度:{" "}
                                  {(source.similarity * 100).toFixed(0)}%)
                                </span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    {msg.role === "assistant" && (
                      <MessageUsageBar usages={msg.modelUsages} />
                    )}
                  </div>
                  </div>
                );
              })}
            <div ref={messagesEndRef} />
            {error && (
              <div className="flex justify-start">
                <div className="w-full rounded-2xl bg-red-900/30 px-4 py-3 text-sm text-red-400">
                  {error}
                </div>
              </div>
            )}
          </div>
        </div>

        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          webSearchEnabled={webSearchEnabled}
          onWebSearchEnabledChange={setWebSearchEnabled}
          knowledgeSearchEnabled={knowledgeSearchEnabled}
          onKnowledgeSearchEnabledChange={setKnowledgeSearchEnabled}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          onSend={handleSend}
          onStop={handleStop}
          isRunning={Boolean(loading || streaming)}
          disabled={!input.trim()}
        />
      </main>
    </div>
    </AuthGate>
  );
}
