export const VISUAL_PIPELINE_VERSION = 'visual-page-v1';
export const VISUAL_BUCKET = 'knowledge-visuals';
export const MAX_VISUAL_BYTES = 5 * 1024 * 1024;
export const MAX_VISUAL_ASSETS = 200;
export const MAX_VISUAL_ANALYSIS_ASSETS = 20;

export type ParsedVisual = {
  occurrenceKey: string;
  kind: 'pdf_page' | 'embedded_image';
  pageNumber?: number;
  textStart?: number;
  textEnd?: number;
  alt?: string;
  bytes?: Uint8Array;
  mimeType?: string;
};

export type VisualRef = {
  assetId: string;
  fileId: string;
  sourceVersion: string;
  generationId: string;
  pageNumber?: number;
};

export type VisualAsset = {
  id: string;
  user_id: string;
  file_id: string;
  generation_id: string;
  source_version: string;
  kind: ParsedVisual['kind'];
  occurrence_key: string;
  page_number: number | null;
  text_start: number | null;
  text_end: number | null;
  alt_text: string;
  storage_path: string | null;
  mime_type: string | null;
  blob_sha256: string | null;
  render_status: 'pending' | 'ready' | 'failed';
  analysis_status: 'ready' | 'failed' | 'skipped';
  description: string;
  analysis_model: string | null;
  warnings: string[];
};

export function assetRef(asset: VisualAsset): VisualRef {
  return {
    assetId: asset.id, fileId: asset.file_id, sourceVersion: asset.source_version,
    generationId: asset.generation_id,
    ...(asset.page_number ? { pageNumber: asset.page_number } : {}),
  };
}

export function parseVisualRefs(value: unknown): VisualRef[] {
  if (!Array.isArray(value)) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return value.slice(0, MAX_VISUAL_ASSETS).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const v = item as Record<string, unknown>;
    if (typeof v.assetId !== 'string' || !uuid.test(v.assetId)
      || typeof v.fileId !== 'string' || !uuid.test(v.fileId)
      || typeof v.generationId !== 'string' || !uuid.test(v.generationId)
      || typeof v.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceVersion)) return [];
    return [{ assetId: v.assetId, fileId: v.fileId, generationId: v.generationId,
      sourceVersion: v.sourceVersion,
      ...(typeof v.pageNumber === 'number' && Number.isInteger(v.pageNumber) && v.pageNumber > 0
        ? { pageNumber: v.pageNumber } : {}) }];
  });
}
