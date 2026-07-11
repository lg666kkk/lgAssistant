"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export function getBrowserSupabase() {
  if (browserClient) return browserClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase 浏览器端环境变量");
  }

  browserClient = createBrowserClient(supabaseUrl, supabaseKey);
  return browserClient;
}

export async function getAccessToken() {
  const {
    data: { session },
  } = await getBrowserSupabase().auth.getSession();
  return session?.access_token ?? null;
}

function redirectToLogin() {
  if (typeof window === "undefined") return;

  const current = `${window.location.pathname}${window.location.search}`;
  const target = `/login?next=${encodeURIComponent(current)}`;

  if (window.location.pathname !== "/login") {
    window.location.assign(target);
  }
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    await getBrowserSupabase().auth.signOut().catch(() => undefined);
    redirectToLogin();
  }

  return response;
}
