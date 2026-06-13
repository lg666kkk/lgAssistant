"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useChatManager } from "@/hooks/use-chat-manager";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./components/chat-input";
import { defaultChatModel, type ChatModelId } from "@/lib/agent/models";

export default function Home() {
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
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [selectedModel, setSelectedModel] =
    useState<ChatModelId>(defaultChatModel);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);

  const { messages, loading, streaming, error } = activeSession || {};
  const lastMessageContent = messages?.length
    ? messages[messages.length - 1]?.content
    : "";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, lastMessageContent]);

  const handleSend = async () => {
    if (!input.trim() || loading || !activeSession) return;
    const text = input;
    setInput("");
    moveSessionToTop(activeSession.id);
    requestAnimationFrame(() => inputRef.current?.focus());
    await activeSession.send(text, rerender, {
      webSearchEnabled,
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
    requestAnimationFrame(() => inputRef.current?.focus());
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
          <Link
            href="/traces"
            className="mt-2 block w-full rounded-xl border border-slate-800 px-4 py-2 text-center text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors whitespace-nowrap"
          >
            📊 Trace 观测
          </Link>
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
                                        className="bg-slate-700/70 rounded-md px-2"
                                        onClick={async () => {
                                          await activeSession?.confirmToolCall(
                                            i,
                                            idx,
                                          );
                                          rerender();
                                        }}
                                      >
                                        确认执行
                                      </button>
                                      <button
                                        onClick={async () => {
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
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          onSend={handleSend}
          onStop={handleStop}
          isRunning={Boolean(loading || streaming)}
          disabled={!input.trim()}
        />
      </main>
    </div>
  );
}
