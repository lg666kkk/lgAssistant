import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateKnowledgeMedia, knowledgeMediaBlock } from './knowledge-media';
import { toAIMessages } from './model-provider';
import { estimateTokens } from './budget';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/knowledge/visual-assets', () => ({ loadKnowledgeVisual: mocks.load }));
const ref = { assetId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  generationId: '00000000-0000-4000-8000-000000000003', sourceVersion: 'a'.repeat(64),
  evidenceId: 'ev_000000000001', mediaType: 'image/png' };
const messages = () => [{ role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read_knowledge_visual', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
    { type: 'text', text: '[ev_000000000001] Original document' }, knowledgeMediaBlock(ref),
  ] }] }] as any;
beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }); });
describe('visual model transport', () => {
  it('hydrates only the request copy and completes tool receipts before images', async () => {
    const history = messages();
    const hydrated = await hydrateKnowledgeMedia(history, 'owner');
    expect(JSON.stringify(history)).not.toContain('AQID');
    expect(JSON.stringify(history)).toContain('knowledge-visual:');
    expect(mocks.load).toHaveBeenCalledWith('owner', expect.objectContaining({ sourceVersion: ref.sourceVersion }), undefined);
    const payload = toAIMessages(hydrated);
    expect(payload.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(payload[1].content[0].toolCallId).toBe('read-1');
    expect(payload[1].content[0].output.value).not.toContain('AQID');
    expect(payload[2].content[1]).toEqual({ type: 'image', image: 'AQID', mediaType: 'image/png' });
  });
  it('does not load images for non-vision models or absent identity', async () => {
    const result = await hydrateKnowledgeMedia(messages(), 'owner', undefined, false);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('当前模型不支持图片');
    await expect(hydrateKnowledgeMedia(messages())).rejects.toThrow('identity');
  });
  it('accounts for reference images and rejects excessive context images', async () => {
    const image = knowledgeMediaBlock(ref);
    expect(estimateTokens(image)).toBeGreaterThanOrEqual(384);
    const content = Array.from({ length: 7 }, () => image);
    await expect(hydrateKnowledgeMedia([{ role: 'user', content }], 'owner')).rejects.toThrow('budget');
  });
});
