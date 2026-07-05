import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type User } from "@supabase/supabase-js";

function getSupabaseAuthConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase Auth 环境变量");
  }

  return { supabaseUrl, supabaseKey };
}

export function createSupabaseServerClient() {
  const { supabaseUrl, supabaseKey } = getSupabaseAuthConfig();
  const cookieStore = cookies();

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, headers) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components 里不能 set cookie；middleware 会负责刷新 session。
        }

        // Route Handler 能通过 cookies().set 写 Set-Cookie；headers 主要由 middleware 响应处理。
        void headers;
      },
    },
  });
}

function createBearerAuthClient() {
  const { supabaseUrl, supabaseKey } = getSupabaseAuthConfig();
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function unauthorized(message = "请先登录") {
  return Response.json({ error: message }, { status: 401 });
}

async function getUserFromBearerToken(req: Request): Promise<User | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) return null;

  const supabase = createBearerAuthClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return data.user;
}

export async function getUserFromRequest(req: Request): Promise<User | null> {
  const cookieClient = createSupabaseServerClient();
  const { data, error } = await cookieClient.auth.getUser();
  if (!error && data.user) {
    return data.user;
  }

  // 兼容迁移前的 Authorization: Bearer <access_token> 请求。
  return getUserFromBearerToken(req);
}

export async function requireUser(req: Request): Promise<User | Response> {
  const user = await getUserFromRequest(req);
  return user ?? unauthorized();
}
