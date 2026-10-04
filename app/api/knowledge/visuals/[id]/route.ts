import { requireUser } from '@/lib/auth/server';
import { getSupabase } from '@/lib/platform/supabase';
import { assetRef, type VisualAsset } from '@/lib/knowledge/visual-types';
import { loadKnowledgeVisual } from '@/lib/knowledge/visual-assets';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return Response.json({ error: '无效资源 ID' }, { status: 400 });
  }
  try {
    const { data, error } = await getSupabase().from('knowledge_visual_assets').select('*')
      .eq('id', params.id).eq('user_id', user.id).maybeSingle();
    if (error || !data) return Response.json({ error: '资源不可用' }, { status: 404 });
    const image = await loadKnowledgeVisual(user.id, assetRef(data as VisualAsset), req.signal);
    return new Response(Buffer.from(image.bytes), { headers: {
      'Content-Type': image.mimeType, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
    } });
  } catch {
    return Response.json({ error: '原图不可用或版本已更新，请重新检索' }, { status: 409 });
  }
}
