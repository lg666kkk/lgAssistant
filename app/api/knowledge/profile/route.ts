import { requireUser } from "@/lib/auth/server";
import {
  clearCustomKnowledgeProfile,
  readKnowledgeProfileDetails,
  saveCustomKnowledgeProfile,
} from "@/lib/agent/tools/knowledge-profile";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  try {
    const profile = await readKnowledgeProfileDetails({ userId: user.id });
    return Response.json(profile, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取知识库画像失败" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: { customProfile?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.customProfile !== "string") {
    return Response.json({ error: "customProfile 必须是字符串" }, { status: 400 });
  }

  try {
    const profile = await saveCustomKnowledgeProfile({
      userId: user.id,
      customProfile: body.customProfile,
    });
    return Response.json(profile, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存知识库画像失败";
    return Response.json(
      { error: message },
      { status: message.includes("尚未生成") ? 409 : 400, headers: NO_STORE_HEADERS },
    );
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  try {
    const profile = await clearCustomKnowledgeProfile({ userId: user.id });
    return Response.json(profile, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "恢复自动画像失败";
    return Response.json(
      { error: message },
      { status: message.includes("尚未生成") ? 409 : 400, headers: NO_STORE_HEADERS },
    );
  }
}
