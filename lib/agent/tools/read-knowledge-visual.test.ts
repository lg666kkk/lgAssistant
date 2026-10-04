import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadKnowledgeVisualTool } from './read-knowledge-visual';
import { VisualAccessRegistry } from './visual-access';
const mocks = vi.hoisted(() => ({ load: vi.fn(), analyze: vi.fn(), vision: vi.fn(), current: vi.fn() }));
vi.mock('@/lib/knowledge/visual-assets', () => ({ loadKnowledgeVisual: mocks.load }));
vi.mock('@/lib/knowledge/visual-analysis', () => ({ analyzeKnowledgeVisual: mocks.analyze, resolveKnowledgeVisionModel: mocks.vision }));
vi.mock('@/lib/llm/config-service', () => ({ resolveUserLlmModel: mocks.current }));
const ref = { assetId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  generationId: '00000000-0000-4000-8000-000000000003', sourceVersion: 'a'.repeat(64), pageNumber: 2 };
const context = { userId: 'owner', requestId: 'request', model: 'main' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: 'image/png', title: 'diagram.pdf' });
  mocks.current.mockResolvedValue({ id: 'main', supportsImages: false });
  mocks.vision.mockResolvedValue({ id: 'vision', pricing: { inputCacheMiss: 1, output: 2 } });
  mocks.analyze.mockResolvedValue({ text: '支付服务调用订单服务，箭头指向订单服务。', modelId: 'vision', usage: { inputTokens: 100, outputTokens: 50 } });
});
describe('original visual reading tool', () => {
  function tool() { const access = new VisualAccessRegistry(); access.grant('owner', 'request', [ref]); return createReadKnowledgeVisualTool(access); }
  it('returns cited observations for non-vision main models without media bytes', async () => {
    const result = await tool().execute({ assetIds: [ref.assetId], question: '箭头方向是什么？' }, context);
    expect(result.ok).toBe(true);
    expect(result.mediaRefs).toEqual([]);
    expect(result.content).toContain('visual_observation');
    expect(result.data).toMatchObject({ evidenceBundle: { evidences: [{
      documentVersion: ref.sourceVersion, kind: 'visual_observation', citation: { pageNumber: 2, assetId: ref.assetId },
    }] } });
    expect(JSON.stringify(result)).not.toContain('base64');
  });
  it('returns opaque media references for vision main models', async () => {
    mocks.current.mockResolvedValue({ id: 'main', supportsImages: true });
    const result = await tool().execute({ assetIds: [ref.assetId], question: '核实图片' }, context);
    expect(result.mediaRefs?.[0]).toMatchObject(ref);
    expect(result.mediaRefs?.[0].evidenceId).toMatch(/^ev_[a-f0-9]{12}$/);
  });
  it('refuses guessed references and missing vision capability before storage access', async () => {
    const result = await tool().execute({ assetIds: ['guessed'], question: '核实' }, context);
    expect(result.ok).toBe(false); expect(mocks.load).not.toHaveBeenCalled();
    mocks.vision.mockResolvedValue(null);
    expect((await tool().execute({ assetIds: [ref.assetId], question: '核实' }, context)).ok).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
