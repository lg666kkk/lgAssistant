"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;

function fetchWithStorageTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const requestUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (!requestUrl.includes("/storage/v1/") || init?.signal) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
  });
}

export function getBrowserSupabase() {
  if (browserClient) return browserClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase 浏览器端环境变量");
  }

  browserClient = createBrowserClient(supabaseUrl, supabaseKey, {
    global: { fetch: fetchWithStorageTimeout },
  });
  return browserClient;
}

export async function getAccessToken() {
  const {
    data: { session },
  } = await getBrowserSupabase().auth.getSession();
  return session?.access_token ?? null;
}

export const LOGIN_REQUIRED_EVENT = "auth:login-required";

function requestLogin() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LOGIN_REQUIRED_EVENT));
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
    requestLogin();
  }

  return response;
}
