"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    try {
      if (!input.trim() || loading) return;
      setLoading(true);
      setError("");
      const userMessage: Message = { role: "user", content: input };
      const newMessages = [...messages, userMessage];
      setMessages([...newMessages, { role: "assistant", content: "" }]);
      setInput("");
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: newMessages }),
      });
      if (!response.ok) {
        throw new Error("请求失败, 请稍后重试");
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: updated[updated.length - 1].content + text,
          };
          return updated;
        });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "发生未知错误");
      setMessages((prev) =>
        prev.filter(
          (_, i) =>
            !(
              i === prev.length - 1 &&
              prev[i].role === "assistant" &&
              !prev[i].content
            ),
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex h-screen flex-col bg-slate-950">
      {/* 顶部标题栏 */}
      <header className="border-b border-slate-800 px-6 py-4">
        <h1 className="text-lg font-semibold text-white">LG的个人知识助手</h1>
      </header>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-slate-500 mt-20">
            发送一条消息开始对话
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-cyan-600 text-white"
                  : "bg-slate-800 text-slate-200"
              }`}
            >
              <ReactMarkdown
                components={{
                  code({ className, children }) {
                    const language = className?.replace("language-", "");
                    if (!language) {
                      // 行内代码
                      return (
                        <code className="bg-slate-700 px-1.5 py-0.5 rounded text-sm">
                          {children}
                        </code>
                      );
                    }
                    // 代码块
                    return (
                      <SyntaxHighlighter language={language} style={oneDark}>
                        {String(children).replace(/\n$/, "")}
                      </SyntaxHighlighter>
                    );
                  },
                }}
              >
                {msg.content || (loading ? "思考中..." : "")}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {error && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-red-900/30 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          </div>
        )}
      </div>

      {/* 底部输入区域 */}
      <div className="border-t border-slate-800 bg-slate-900 p-4">
        <div className="mx-auto flex max-w-3xl gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="输入消息..."
            className="flex-1 rounded-xl bg-slate-800 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none focus:ring-2 focus:ring-cyan-500"
          />
          <button
            onClick={handleSend}
            disabled={loading}
            className="rounded-xl bg-cyan-600 px-6 py-3 text-sm font-medium text-white hover:bg-cyan-500 transition-colors disabled:opacity-50"
          >
            {loading ? "思考中..." : "发送"}
          </button>
        </div>
      </div>
    </main>
  );
}
