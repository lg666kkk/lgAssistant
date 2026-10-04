import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadKnowledgeVisual, visualRefsInSpan } from './visual-assets';
import type { VisualAsset } from './visual-types';
const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/platform/supabase', () => ({ getSupabase: () => ({ from: mocks.from,
  storage: { from: () => ({ download: mocks.download }) } }) }));
const ref = { assetId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  generationId: '00000000-0000-4000-8000-000000000003', sourceVersion: 'a'.repeat(64) };
const asset = { id: ref.assetId, user_id: 'owner', file_id: ref.fileId,
  generation_id: ref.generationId, source_version: ref.sourceVersion,
  kind: 'embedded_image', storage_path: `owner/${ref.fileId}/${ref.generationId}/image.png`,
  render_status: 'ready',
  mime_type: 'image/png', page_number: null, text_start: 10, text_end: 20 } as VisualAsset;
function queueRows(rows: unknown[]) {
  const eq = vi.fn();
  mocks.from.mockImplementation(() => {
    const q: any = { select: () => q, eq: (...args: unknown[]) => { eq(...args); return q; },
      maybeSingle: async () => ({ data: rows.shift(), error: null }) };
    return q;
  });
  return eq;
}
function png() {
  const b = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.writeUInt32BE(100, 16); b.writeUInt32BE(100, 20); return b;
}
beforeEach(() => { vi.clearAllMocks(); mocks.download.mockResolvedValue({ data: new Blob([png()]), error: null }); });
describe('visual storage identity and revocation', () => {
  it('rejects a stale generation before reading storage', async () => {
    queueRows([asset, { sha256: ref.sourceVersion, active_generation_id: 'other' }]);
    await expect(loadKnowledgeVisual('owner', ref)).rejects.toThrow('stale_reference');
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('revokes reads when deleted during download and scopes every query', async () => {
    const eq = queueRows([asset, { sha256: ref.sourceVersion, active_generation_id: ref.generationId }, null]);
    await expect(loadKnowledgeVisual('owner', ref)).rejects.toThrow('stale_reference');
    expect(eq).toHaveBeenCalledWith('user_id', 'owner');
  });
  it('rejects mismatched object paths even when the metadata row exists', async () => {
    queueRows([{ ...asset, storage_path: 'other-user/image.png' },
      { sha256: ref.sourceVersion, active_generation_id: ref.generationId }]);
    await expect(loadKnowledgeVisual('owner', ref)).rejects.toThrow('path');
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('returns valid image bytes only for the active owned version', async () => {
    queueRows([asset, { sha256: ref.sourceVersion, active_generation_id: ref.generationId },
      { active_generation_id: ref.generationId }]);
    expect(await loadKnowledgeVisual('owner', ref)).toMatchObject({ mimeType: 'image/png' });
  });
  it('associates document occurrences and PDF physical pages independently', () => {
    const page = { ...asset, id: 'page', page_number: 3, text_start: null } as VisualAsset;
    expect(visualRefsInSpan([asset, page], 11, 14).map((r) => r.assetId)).toEqual([asset.id]);
    expect(visualRefsInSpan([asset, page], 50, 60, 3, 3).map((r) => r.assetId)).toEqual(['page']);
  });
});
