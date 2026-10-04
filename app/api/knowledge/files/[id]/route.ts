import { requireUser } from "@/lib/auth/server";
import { enqueueKnowledgeProfileRefresh } from "@/lib/agent/tools/knowledge-profile";
import {
  createKnowledgeFileSignedUrl,
  deleteKnowledgeFile,
  filePageId,
} from "@/lib/knowledge/files";
import { enqueueRagIngestionJob } from "@/lib/knowledge/ingestion-queue";
import { getSupabase } from '@/lib/platform/supabase';

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: { id: string } };

function invalidId(id: string) {
  return !UUID_PATTERN.test(id);
}

/**
 * 引用链接入口：鉴权后跳转到短期签名 URL。
 */
export async function GET(req: Request, { params }: RouteContext) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (invalidId(params.id)) return Response.json({ error: "无效的文件 ID" }, { status: 400 });
  try {
    const signedUrl = await createKnowledgeFileSignedUrl(user.id, params.id);
    if (!signedUrl) return Response.json({ error: "文件不存在" }, { status: 404 });
    return Response.redirect(signedUrl, 302);
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "生成访问链接失败",
    }, { status: 500 });
  }
}

/**
 * 重新入库（例如解析失败后重试），force 跳过版本比对。
 */
export async function POST(req: Request, { params }: RouteContext) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (invalidId(params.id)) return Response.json({ error: "无效的文件 ID" }, { status: 400 });
  try {
    const body = await req.text();
    if (body) {
      let value: unknown;
      try { value = JSON.parse(body); } catch { return Response.json({ error: '无效 JSON' }, { status: 400 }); }
      if (!value || typeof value !== 'object' || !('enableVisual' in value)
        || (value as { enableVisual: unknown }).enableVisual !== true) {
        return Response.json({ error: 'enableVisual 必须为 true' }, { status: 400 });
      }
      const { data, error } = await getSupabase().rpc('enable_knowledge_visual_index', {
        p_user_id: user.id, p_file_id: params.id,
      });
      if (error?.code === 'P0002') return Response.json({ error: '文件不存在' }, { status: 404 });
      if (error) throw new Error(error.message);
      return Response.json({ job: Array.isArray(data) ? data[0] : data }, { status: 202 });
    }
    const job = await enqueueRagIngestionJob({
      userId: user.id,
      pageId: filePageId(params.id),
      tree: false,
      force: true,
    });
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "创建 ingestion job 失败",
    }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (invalidId(params.id)) return Response.json({ error: "无效的文件 ID" }, { status: 400 });
  try {
    const deleted = await deleteKnowledgeFile(user.id, params.id);
    if (!deleted) return Response.json({ error: "文件不存在" }, { status: 404 });
    await enqueueKnowledgeProfileRefresh({ userId: user.id });
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "删除文件失败",
    }, { status: 500 });
  }
}
