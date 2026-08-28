import { requireUser } from "@/lib/auth/server";
import {
  getUserProfileView,
  updateUserProfile,
} from "@/lib/user-profile/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserProfileView(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取用户画像失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { content?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return Response.json({ error: "用户画像内容格式错误" }, { status: 400 });
  }
  try {
    return Response.json(await updateUserProfile({
      userId: user.id,
      content: body.content,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存用户画像失败" },
      { status: 400 },
    );
  }
}
