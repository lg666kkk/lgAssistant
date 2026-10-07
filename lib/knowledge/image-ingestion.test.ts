import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncKnowledgeFile, uploadKnowledgeFile } from './files';

const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn(), upload: vi.fn(), index: vi.fn(), vision: vi.fn(), ocr: vi.fn() }));
vi.mock('@/lib/platform/supabase', () => ({ getSupabase: () => ({
  from: mocks.from, storage: { from: () => ({ download: mocks.download, upload: mocks.upload }) },
}) }));
vi.mock('./sync', () => ({ indexSourceDocument: mocks.index,
  failedSyncResult: (_pageId: string, _options: unknown, error: Error) => ({ success: false, error: error.message }),
}));
vi.mock('./visual-assets', () => ({ prepareVisualGeneration: mocks.vision, visualRefsInSpan: vi.fn(() => []) }));
vi.mock('./image-ocr', () => ({ ocrKnowledgeImage: mocks.ocr }));

const record = { id: 'image-1', user_id: 'owner', file_name: 'diagram.png', file_kind: 'image',
  sha256: 'hash', storage_path: 'owner/image-1/source.png', created_at: '2026-10-05T00:00:00Z', visual_enabled: false };
const asset = { id: 'asset-1', file_id: record.id, generation_id: 'generation-1', source_version: 'hash',
  analysis_status: 'ready', description: '医药商家订单流程：查询订单 → 接单 → 拣货完成 → 发配送。', page_number: null };
let bytes: Buffer;

beforeEach(async () => {
  vi.resetAllMocks();
  bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'white' } }).png().toBuffer();
  const query: any = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: record, error: null }) };
  mocks.from.mockReturnValue(query);
  mocks.download.mockResolvedValue({ data: new Blob([new Uint8Array(bytes)]), error: null });
  mocks.index.mockResolvedValue({ success: true });
  mocks.vision.mockResolvedValue({ id: 'generation-1', expectedGeneration: null, assets: [asset], warnings: [],
    modelId: 'vision-model', status: 'ready', pipelineVersion: 'test' });
  mocks.ocr.mockResolvedValue('OCR fallback text');
});

describe('vision-first image ingestion', () => {
  it('analyzes even legacy images without a visual opt-in and never runs OCR on success', async () => {
    expect(await syncKnowledgeFile(record.id, { userId: 'owner' })).toMatchObject({ success: true });
    expect(mocks.vision).toHaveBeenCalledWith(expect.objectContaining({ analyze: true, content: '' }));
    expect(mocks.ocr).not.toHaveBeenCalled();
    const indexed = mocks.index.mock.calls[0][0];
    expect(indexed.content).toBe(asset.description);
    expect(indexed.pageMetadata).toMatchObject({ text_extraction: 'vision', vision_model: 'vision-model' });
    expect(indexed.chunkMetadata({ startChar: 20, endChar: 35 }).visual_refs[0].assetId).toBe('asset-1');
  });

  it.each(['unconfigured', 'partial'])('falls back to OCR when vision is %s', async (status) => {
    mocks.vision.mockResolvedValue({ id: 'generation-1', assets: [{ ...asset, analysis_status: 'failed', description: '' }],
      warnings: [], modelId: null, status, pipelineVersion: 'test' });
    expect(await syncKnowledgeFile(record.id, { userId: 'owner' })).toMatchObject({ success: true });
    expect(mocks.ocr).toHaveBeenCalledOnce();
    expect(mocks.index.mock.calls[0][0]).toMatchObject({ content: 'OCR fallback text', pageMetadata: { text_extraction: 'ocr' } });
    expect(mocks.vision.mock.invocationCallOrder[0]).toBeLessThan(mocks.ocr.mock.invocationCallOrder[0]);
  });

  it('does not report successful indexing if both methods produce no content', async () => {
    mocks.vision.mockResolvedValue({ assets: [], warnings: [], status: 'unconfigured' });
    mocks.ocr.mockResolvedValue('');
    expect(await syncKnowledgeFile(record.id, { userId: 'owner' })).toMatchObject({ success: false });
    expect(mocks.index).not.toHaveBeenCalled();
  });

  it('enables vision by default when uploading a new image', async () => {
    const inserted = vi.fn();
    const query: any = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: (value: unknown) => { inserted(value); return query; },
      single: async () => ({ data: record, error: null }),
    };
    mocks.from.mockReturnValue(query);
    mocks.upload.mockResolvedValue({ error: null });
    await uploadKnowledgeFile({ userId: 'owner', fileName: 'diagram.png', bytes });
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ visual_enabled: true, file_kind: 'image' }));
  });
});
