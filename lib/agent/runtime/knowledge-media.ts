import type Anthropic from '@anthropic-ai/sdk';
import type { ToolMediaRef } from '@/lib/agent/tools/types';
import { parseVisualRefs } from '@/lib/knowledge/visual-types';
import { loadKnowledgeVisual } from '@/lib/knowledge/visual-assets';

const PREFIX = 'knowledge-visual:';

export function knowledgeMediaBlock(ref: ToolMediaRef): Anthropic.ImageBlockParam {
  return { type: 'image', source: { type: 'url', url: `${PREFIX}${encodeURIComponent(JSON.stringify(ref))}` } };
}

/** Hydrate only the request view; persisted history contains references, never image bytes. */
export async function hydrateKnowledgeMedia(messages: Anthropic.MessageParam[], userId?: string,
  signal?: AbortSignal, supportsImages = true): Promise<Anthropic.MessageParam[]> {
  const cache = new Map<string, Anthropic.ImageBlockParam>();
  let count = 0;
  const hydrate = async (block: any): Promise<any> => {
    if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: await Promise.all(block.content.map(hydrate)) };
    }
    if (block?.type !== 'image' || block.source?.type !== 'url'
      || !String(block.source.url).startsWith(PREFIX)) return block;
    if (!supportsImages) return { type: 'text', text: '原图未发送：当前模型不支持图片，请仅使用文字观察记录。' };
    if (!userId) throw new Error('Visual request missing user identity');
    if (++count > 6) throw new Error('Visual context image budget exceeded');
    const key = String(block.source.url);
    if (cache.has(key)) return cache.get(key)!;
    const ref = parseVisualRefs([JSON.parse(decodeURIComponent(key.slice(PREFIX.length)))])[0];
    if (!ref) throw new Error('Invalid visual media reference');
    let image: Awaited<ReturnType<typeof loadKnowledgeVisual>>;
    try { image = await loadKnowledgeVisual(userId, ref, signal); }
    catch {
      signal?.throwIfAborted();
      return { type: 'text', text: '原图引用已失效或不可用；不要据此声称已查看原图，需要时重新检索当前版本。' };
    }
    const result: Anthropic.ImageBlockParam = { type: 'image', source: { type: 'base64',
      media_type: image.mimeType as 'image/png' | 'image/jpeg', data: Buffer.from(image.bytes).toString('base64') } };
    cache.set(key, result);
    return result;
  };
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages) result.push({ ...message, content: Array.isArray(message.content)
    ? await Promise.all(message.content.map(hydrate)) : message.content });
  return result;
}
