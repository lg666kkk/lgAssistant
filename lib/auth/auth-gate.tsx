"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "./use-auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        加载登录状态...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 px-6 text-slate-200">
        <div className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-lg font-semibold text-white">需要登录</h1>
          <p className="mt-2 text-sm text-slate-400">
            登录后，对话、知识库、Trace 和用量统计会按用户隔离。
          </p>
          <Link
            href="/login"
            className="mt-5 block rounded-md bg-cyan-500 px-4 py-2 text-center text-sm font-medium text-slate-950 hover:bg-cyan-400"
          >
            去登录
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
