import { createClient, type User } from "@supabase/supabase-js";

function createAuthClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase Auth 环境变量");
  }

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

export async function getUserFromRequest(req: Request): Promise<User | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) return null;

  const supabase = createAuthClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return data.user;
}

export async function requireUser(req: Request): Promise<User | Response> {
  const user = await getUserFromRequest(req);
  return user ?? unauthorized();
}
