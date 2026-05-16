"use client";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useChatManager } from "@/hooks/use-chat-manager";

export default function Home() {
  const {
    sessions,
    activeId,
    activeSession,
    createSession,
    switchSession,
    deleteSession,
    rerender,
    loading: sessionsLoading,
  } = useChatManager();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    requestAnimationFrame(() => inputRef.current?.focus());
    await activeSession.send(text, rerender);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleStop = () => {
    activeSession?.abort();
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
        </div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => switchSession(session.id)}
              className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-sm cursor-pointer transition-colors whitespace-nowrap ${
                session.id === activeId
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300"
              }`}
            >
              <span className="truncate">{session.title}</span>
              {sessions.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(session.id);
                  }}
                  className="ml-2 shrink-0 text-slate-500 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
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

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages && messages.length === 0 && (
            <p className="text-center text-slate-500 mt-20">
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
                    className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-cyan-600 text-white"
                        : "bg-slate-800 text-slate-200"
                    } ${isStreaming ? "streaming-msg" : ""}`}
                  >
                    <ReactMarkdown
                      components={{
                        p({ children }) {
                          return <p>{children}</p>;
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
                                <div>
                                  <span className="text-slate-400">状态：</span>
                                  <span
                                    className={
                                      toolCall.ok
                                        ? "text-emerald-400"
                                        : "text-red-400"
                                    }
                                  >
                                    {toolCall.ok ? "成功" : "失败"}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-400">结果：</span>
                                  <span>{toolCall.content}</span>
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
                                className="block text-xs text-cyan-400 hover:text-cyan-300 hover:underline transition-colors"
                              >
                                [{idx + 1}] {source.title}
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
              <div className="rounded-2xl bg-red-900/30 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 bg-slate-900 p-4">
          <div className="mx-auto flex max-w-3xl gap-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="输入消息..."
              rows={1}
              className="max-h-40 min-h-[46px] flex-1 resize-none rounded-xl bg-slate-800 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none focus:ring-2 focus:ring-cyan-500"
            />
            {loading || streaming ? (
              <button
                onClick={handleStop}
                className="rounded-xl bg-red-600 px-6 py-3 text-sm font-medium text-white hover:bg-red-500 transition-colors"
              >
                停止
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="rounded-xl bg-cyan-600 px-6 py-3 text-sm font-medium text-white hover:bg-cyan-500 transition-colors disabled:opacity-50"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
