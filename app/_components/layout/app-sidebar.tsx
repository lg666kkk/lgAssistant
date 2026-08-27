"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Blocks,
  BookOpen,
  Bot,
  ChartNoAxesColumnIncreasing,
  Clock3,
  CodeXml,
  Database,
  Ellipsis,
  FileText,
  Grid3x3,
  Landmark,
  Languages,
  ListChecks,
  LogOut,
  MessageCircle,
  Pencil,
  Plus,
  Plug,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { ChatSession } from "@/lib/chat/chat-session";

export type PrimaryCapability = "chat" | "connections" | "custom-agents";
export type ConnectionTabId =
  | "language-model"
  | "embedding"
  | "search-engine"
  | "usage"
  | "knowledge"
  | "mcp"
  | "skills"
  | "schedule"
  | "user-profile"
  | "memory-list"
  | "traces"
  | "langfuse";
export type CustomAgentTabId = "english" | "go" | "finance" | "coding" | "research-report";

const connectionTabGroups: Array<{
  label: string;
  items: Array<{ id: ConnectionTabId; label: string; icon: LucideIcon }>;
}> = [
  {
    label: "API 密钥",
    items: [
      { id: "language-model", label: "大语言模型", icon: Bot },
      { id: "embedding", label: "向量嵌入", icon: Database },
      { id: "search-engine", label: "搜索引擎", icon: Search },
      { id: "usage", label: "用量统计", icon: ChartNoAxesColumnIncreasing },
    ],
  },
  {
    label: "集成",
    items: [
      { id: "knowledge", label: "知识库", icon: BookOpen },
      { id: "mcp", label: "MCP 服务", icon: SquareTerminal },
      { id: "skills", label: "技能", icon: Sparkles },
      { id: "schedule", label: "定时任务", icon: Clock3 },
      { id: "user-profile", label: "用户画像", icon: UserRound },
      { id: "memory-list", label: "记忆清单", icon: ListChecks },
    ],
  },
  {
    label: "日志",
    items: [
      { id: "traces", label: "Trace", icon: Activity },
      { id: "langfuse", label: "Langfuse", icon: ChartNoAxesColumnIncreasing },
    ],
  },
];

const customAgentTabs: Array<{
  id: CustomAgentTabId;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "english", label: "英语", icon: Languages },
  { id: "go", label: "围棋", icon: Grid3x3 },
  { id: "finance", label: "金融", icon: Landmark },
  { id: "coding", label: "编码", icon: CodeXml },
  { id: "research-report", label: "研报", icon: FileText },
];

export function getConnectionTabLabel(tabId: ConnectionTabId) {
  return connectionTabGroups
    .flatMap((group) => group.items)
    .find((item) => item.id === tabId)?.label ?? "连接";
}

export function getCustomAgentTabLabel(tabId: CustomAgentTabId) {
  return customAgentTabs.find((item) => item.id === tabId)?.label ?? "定制化";
}

function maskEmail(email?: string | null) {
  if (!email) return "未登录";
  const [name, domain] = email.split("@");
  if (!domain) return email;
  if (name.length <= 2) return `${name[0] ?? ""}***@${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

const accountLinks = [
  { href: "/usage", label: "用量统计", icon: ChartNoAxesColumnIncreasing },
  { href: "/schedule", label: "定时任务", icon: Clock3 },
  { href: "/settings", label: "系统设置", icon: Settings },
] as const;

type AppSidebarProps = {
  open: boolean;
  activeCapability: PrimaryCapability;
  activeConnectionTab: ConnectionTabId;
  activeCustomAgentTab: CustomAgentTabId;
  sessions: ChatSession[];
  activeSessionId: string;
  userEmail?: string | null;
  onCapabilityChange: (capability: PrimaryCapability) => void;
  onConnectionTabChange: (tab: ConnectionTabId) => void;
  onCustomAgentTabChange: (tab: CustomAgentTabId) => void;
  onCreateSession: () => void;
  onSwitchSession: (id: string) => void;
  onStopSession: (session: ChatSession) => void;
  onOpenSessionDialog: (mode: "rename" | "delete", session: ChatSession) => void;
  onSignOut: () => void;
};

export function AppSidebar({
  open,
  activeCapability,
  activeConnectionTab,
  activeCustomAgentTab,
  sessions,
  activeSessionId,
  userEmail,
  onCapabilityChange,
  onConnectionTabChange,
  onCustomAgentTabChange,
  onCreateSession,
  onSwitchSession,
  onStopSession,
  onOpenSessionDialog,
  onSignOut,
}: AppSidebarProps) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [accountMenuOpen]);

  const changeCapability = (capability: PrimaryCapability) => {
    onCapabilityChange(capability);
    setAccountMenuOpen(false);
  };

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-slate-800 bg-slate-900 transition-all duration-300 ${
        open ? "w-64" : "w-0 overflow-hidden border-r-0"
      }`}
    >
      <div className="border-b border-slate-800 px-3 py-4">
        <div className="mb-4 flex items-center gap-3 px-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
            <span className="text-sm font-semibold">AI</span>
          </div>
          <span className="truncate text-sm font-semibold text-slate-100">知识助手</span>
        </div>
        <nav aria-label="主要功能" className="space-y-1">
          {([
            { id: "chat", label: "对话", icon: MessageCircle },
            { id: "connections", label: "连接", icon: Plug },
            { id: "custom-agents", label: "定制化", icon: Blocks },
          ] as const).map((item) => {
            const Icon = item.icon;
            const selected = activeCapability === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => changeCapability(item.id)}
                className={`flex h-11 w-full items-center gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-colors ${
                  selected
                    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-200"
                    : "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                }`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {activeCapability === "chat" ? (
        <>
          <div className="px-3 pb-2 pt-4">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-slate-500">最近对话</span>
            </div>
            <button
              type="button"
              onClick={onCreateSession}
              className="flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-700 px-3 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-white"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>新对话</span>
            </button>
          </div>
          <nav aria-label="对话列表" className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => onSwitchSession(session.id)}
                className={`group flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  session.id === activeSessionId
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${session.isRunning ? "bg-emerald-400" : "bg-slate-700"}`}
                  title={session.isRunning ? "运行中" : "空闲"}
                />
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {session.isRunning && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onStopSession(session);
                    }}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-red-300 opacity-80 transition-opacity hover:bg-red-950/50 hover:text-red-200 group-hover:opacity-100"
                    title="停止这个会话"
                  >
                    停止
                  </button>
                )}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSessionDialog("rename", session);
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 opacity-0 transition-all hover:bg-slate-700/70 hover:text-cyan-300 focus-visible:opacity-100 group-hover:opacity-100"
                  title="重命名会话"
                  aria-label={`重命名会话“${session.title}”`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSessionDialog("delete", session);
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                  title="删除会话"
                  aria-label={`删除会话“${session.title}”`}
                  disabled={sessions.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </nav>
        </>
      ) : activeCapability === "connections" ? (
        <nav aria-label="连接设置" className="flex-1 overflow-y-auto px-2 py-4">
          {connectionTabGroups.map((group, groupIndex) => (
            <section key={group.label} aria-labelledby={`connection-group-${groupIndex}`} className={groupIndex === 0 ? "" : "mt-6"}>
              <h2 id={`connection-group-${groupIndex}`} className="mb-2 px-3 text-xs font-medium text-slate-500">
                {group.label}
              </h2>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const selected = item.id === activeConnectionTab;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onConnectionTabChange(item.id)}
                      className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                        selected ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                      }`}
                    >
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${selected ? "text-cyan-300" : "text-slate-500"}`} aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
      ) : (
        <nav aria-label="定制化" className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
          {customAgentTabs.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeCustomAgentTab;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onCustomAgentTabChange(item.id)}
                className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                  selected ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                }`}
              >
                <Icon className={`h-[18px] w-[18px] shrink-0 ${selected ? "text-cyan-300" : "text-slate-500"}`} aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      <div ref={accountMenuRef} className="relative border-t border-slate-800 p-3">
        {accountMenuOpen && (
          <div className="absolute bottom-full left-3 mb-2 w-[232px] rounded-2xl border border-slate-700 bg-slate-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur">
            {accountLinks.map((item, index) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setAccountMenuOpen(false)}
                  className={`${index === 0 ? "" : "mt-1"} flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-200 transition-colors hover:bg-slate-800`}
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                    <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setAccountMenuOpen(false);
                onSignOut();
              }}
              className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
                <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
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
            <UserRound className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{maskEmail(userEmail)}</span>
          <Ellipsis className="h-[18px] w-[18px] shrink-0 text-slate-500" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
