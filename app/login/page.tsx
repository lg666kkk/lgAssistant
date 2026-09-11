"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@web/lib/auth/use-auth";

// Preserve old login links while using the same in-place login dialog.
export default function LoginPage() {
  return <Suspense><LoginRedirect /></Suspense>;
}

function LoginRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  const { requestLogin } = useAuth();
  useEffect(() => {
    const next = params.get("next");
    let target = new URL("/", window.location.origin);
    try { target = new URL(next || "/", window.location.origin); } catch { /* Invalid legacy links return home. */ }
    const safe = target.origin === window.location.origin && target.pathname !== "/login";
    router.replace(safe ? `${target.pathname}${target.search}${target.hash}` : "/");
    requestLogin();
  }, [params, requestLogin, router]);
  return null;
}
