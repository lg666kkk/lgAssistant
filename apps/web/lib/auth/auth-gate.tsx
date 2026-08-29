"use client";

import type { ReactNode } from "react";
import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "./use-auth";

export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AuthGateFallback />}>
      <AuthGateContent>{children}</AuthGateContent>
    </Suspense>
  );
}

function AuthGateContent({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (loading || user) return;

    const query = searchParams.toString();
    const next = `${pathname}${query ? `?${query}` : ""}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [loading, pathname, router, searchParams, user]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        加载登录状态...
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}

function AuthGateFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
      加载登录状态...
    </div>
  );
}
