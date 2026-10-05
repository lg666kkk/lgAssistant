import { createHash, randomUUID } from 'node:crypto';
import { getSupabase } from '@/lib/platform/supabase';
import { renderPdfPage, validateVisualImage } from './visual-renderer';
import { analyzeKnowledgeVisual, resolveKnowledgeVisionModel } from './visual-analysis';
import type { VisualProgress } from './visual-progress';
import { assetRef, MAX_VISUAL_ANALYSIS_ASSETS, VISUAL_BUCKET, VISUAL_PIPELINE_VERSION,
  type ParsedVisual, type VisualAsset, type VisualRef } from './visual-types';

export type PreparedVisualGeneration = {
  id: string;
  expectedGeneration: string | null;
  assets: VisualAsset[];
  warnings: string[];
  modelId: string | null;
  analysisCount: number;
  status: 'ready' | 'partial' | 'unconfigured';
  pipelineVersion: string;
};

export async function prepareVisualGeneration(input: {
  userId: string; fileId: string; sourceVersion: string; sourceBytes: Uint8Array;
  content: string; visuals: ParsedVisual[]; expectedGeneration: string | null;
  analyze: boolean; signal?: AbortSignal;
}): Promise<PreparedVisualGeneration> {
  const db = getSupabase();
  const generationId = randomUUID();
  const progress: VisualProgress = {
    stage: 'rendering', total: input.visuals.length, processed: 0,
    analyzed: 0, failed: 0, skipped: 0, currentPage: null,
  };
  const saveProgress = async () => {
    const { error } = await db.from('knowledge_file_generations').update({ progress })
      .eq('id', generationId).eq('user_id', input.userId);
    if (error) throw new Error(`Saving visual progress failed: ${error.message}`);
  };
  const model = input.analyze ? await resolveKnowledgeVisionModel(input.userId) : null;
  const pipeline = `${VISUAL_PIPELINE_VERSION}:${model?.id ?? 'no-model'}`;
  const { error } = await db.from('knowledge_file_generations').insert({
    id: generationId, user_id: input.userId, file_id: input.fileId,
    source_version: input.sourceVersion, pipeline_version: pipeline, status: 'preparing', progress,
  });
  if (error) throw new Error(`Creating visual generation failed: ${error.message}`);
  const warnings: string[] = [];
  const assets: VisualAsset[] = [];
  let analysisCount = 0;
  let derivedBytes = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const deadline = Date.now() + 240_000;
  for (const visual of input.visuals) {
    input.signal?.throwIfAborted();
    progress.stage = 'rendering';
    progress.currentPage = visual.pageNumber ?? null;
    await saveProgress();
    const asset: VisualAsset = {
      id: randomUUID(), user_id: input.userId, file_id: input.fileId,
      generation_id: generationId, source_version: input.sourceVersion,
      kind: visual.kind, occurrence_key: visual.occurrenceKey,
      page_number: visual.pageNumber ?? null, text_start: visual.textStart ?? null,
      text_end: visual.textEnd ?? null, alt_text: visual.alt ?? '',
      storage_path: null, mime_type: null, blob_sha256: null,
      render_status: visual.kind === 'pdf_page' ? 'pending' : 'failed',
      analysis_status: 'skipped', description: '', analysis_model: null, warnings: [],
    };
    const { error: reserveError } = await db.from('knowledge_visual_assets').insert(asset);
    if (reserveError) throw new Error(`Reserving visual asset failed: ${reserveError.message}`);
    try {
      let image = visual.bytes;
      const mayAnalyze = model && analysisCount < MAX_VISUAL_ANALYSIS_ASSETS && Date.now() < deadline;
      if (!image && visual.kind === 'pdf_page' && mayAnalyze) {
        image = await renderPdfPage(input.sourceBytes, visual.pageNumber!, input.signal);
      }
      if (image) {
        const mime = validateVisualImage(image, visual.mimeType);
        derivedBytes += image.byteLength;
        if (derivedBytes > 64 * 1024 * 1024) throw new Error('Derived image storage budget exceeded');
        const storagePath = `${input.userId}/${input.fileId}/${generationId}/${asset.id}.${mime === 'image/png' ? 'png' : 'jpg'}`;
        // Reserve cleanup identity before uploading bytes; deletion/GC can always find the object.
        const { error: pathError } = await db.from('knowledge_visual_assets').update({ storage_path: storagePath })
          .eq('id', asset.id).eq('user_id', input.userId).select('id').single();
        if (pathError) throw new Error('Visual reservation was revoked');
        asset.storage_path = storagePath;
        const { error: uploadError } = await db.storage.from(VISUAL_BUCKET).upload(storagePath, image, { contentType: mime, upsert: false });
        if (uploadError) throw new Error('Visual image upload failed');
        asset.storage_path = storagePath; asset.mime_type = mime;
        asset.blob_sha256 = createHash('sha256').update(image).digest('hex');
        asset.render_status = 'ready';
        if (mayAnalyze) {
          analysisCount++;
          asset.analysis_status = 'failed';
          progress.stage = 'analyzing';
          await saveProgress();
          const observation = await analyzeKnowledgeVisual({
            model, bytes: image, mimeType: mime, signal: input.signal,
            context: input.content.slice(Math.max(0, (visual.textStart ?? 0) - 500), (visual.textEnd ?? 0) + 500),
          });
          asset.description = observation.text; asset.analysis_model = observation.modelId;
          inputTokens += observation.usage.inputTokens;
          outputTokens += observation.usage.outputTokens;
          asset.analysis_status = 'ready';
        }
      }
      if (model && !mayAnalyze) asset.warnings.push('Visual analysis budget exhausted; page/image not analyzed');
    } catch {
      asset.warnings.push('Visual extraction or analysis failed; text index remains available');
    }
    assets.push(asset);
    warnings.push(...asset.warnings.map((w) => `${visual.occurrenceKey}: ${w}`));
    const { error: saveError } = await db.from('knowledge_visual_assets').update(asset)
      .eq('id', asset.id).eq('user_id', input.userId).select('id').single();
    if (saveError) {
      if (asset.storage_path) await db.storage.from(VISUAL_BUCKET).remove([asset.storage_path]);
      throw new Error('Visual resource was revoked while processing');
    }
    progress.processed++;
    if (asset.analysis_status === 'ready') progress.analyzed++;
    else if (asset.warnings.some((warning) => warning.includes('failed'))) progress.failed++;
    else progress.skipped++;
    await saveProgress();
  }
  const status = !model ? 'unconfigured'
    : assets.every((a) => a.analysis_status === 'ready') ? 'ready' : 'partial';
  if (!model) warnings.push('No explicitly configured vision model; visual content is not searchable yet');
  console.info('[knowledge-visual] analysis usage', { generationId, fileId: input.fileId,
    modelId: model?.id ?? null, analysisCount, inputTokens, outputTokens,
    estimatedCostCny: model ? (inputTokens * (model.pricing.inputCacheMiss ?? 0)
      + outputTokens * (model.pricing.output ?? 0)) / 1_000_000 : 0 });
  const { error: readyError } = await db.from('knowledge_file_generations').update({
    status: 'ready', visual_status: status, warnings,
    progress: { ...progress, stage: 'indexing', currentPage: null },
  }).eq('id', generationId).eq('user_id', input.userId);
  if (readyError) throw new Error(`Preparing generation failed: ${readyError.message}`);
  return { id: generationId, expectedGeneration: input.expectedGeneration, assets, warnings,
    modelId: model?.id ?? null, analysisCount, status, pipelineVersion: pipeline };
}

export function visualRefsInSpan(assets: VisualAsset[], start: number, end: number, pageStart?: number, pageEnd?: number) {
  return assets.filter((a) => a.page_number !== null
    ? pageStart !== undefined && a.page_number >= pageStart && a.page_number <= (pageEnd ?? pageStart)
    : a.text_start !== null && a.text_start < end && (a.text_end ?? a.text_start) >= start)
    .map(assetRef);
}

/** Never accept storage paths from the model; reload current user-owned resource identity. */
export async function loadKnowledgeVisual(userId: string, ref: VisualRef, signal?: AbortSignal) {
  const db = getSupabase();
  const { data: asset, error } = await db.from('knowledge_visual_assets').select('*')
    .eq('user_id', userId).eq('id', ref.assetId).eq('file_id', ref.fileId)
    .eq('generation_id', ref.generationId).eq('source_version', ref.sourceVersion).maybeSingle();
  if (error || !asset) throw new Error('Visual resource unavailable');
  const { data: file, error: fileError } = await db.from('knowledge_files').select('*')
    .eq('user_id', userId).eq('id', ref.fileId).maybeSingle();
  if (fileError || !file || file.sha256 !== ref.sourceVersion || file.active_generation_id !== ref.generationId) {
    throw new Error('stale_reference: retrieve the current document again');
  }
  const record = asset as VisualAsset;
  let bytes: Uint8Array;
  let mimeType: string;
  if (record.storage_path && record.render_status === 'ready') {
    if (!record.storage_path.startsWith(`${userId}/${ref.fileId}/${ref.generationId}/`)) throw new Error('Invalid visual resource path');
    const { data, error: downloadError } = await db.storage.from(VISUAL_BUCKET).download(record.storage_path);
    if (downloadError || !data) throw new Error('Visual resource download failed');
    if (data.size > 5 * 1024 * 1024) throw new Error('Image exceeds byte budget');
    bytes = new Uint8Array(await data.arrayBuffer());
    mimeType = validateVisualImage(bytes, record.mime_type ?? undefined);
  } else if (record.kind === 'pdf_page' && record.page_number) {
    const { data, error: downloadError } = await db.storage.from('knowledge-files').download(file.storage_path);
    if (downloadError || !data || data.size > 20 * 1024 * 1024) throw new Error('PDF source unavailable');
    bytes = await renderPdfPage(new Uint8Array(await data.arrayBuffer()), record.page_number, signal);
    mimeType = validateVisualImage(bytes);
  } else throw new Error('Original image was not imported; unsupported format or limits');
  signal?.throwIfAborted();
  // Deletion or a version switch during download must revoke the read as well.
  const { data: current, error: currentError } = await db.from('knowledge_files')
    .select('active_generation_id').eq('user_id', userId).eq('id', ref.fileId).maybeSingle();
  if (currentError || current?.active_generation_id !== ref.generationId) throw new Error('stale_reference');
  return { bytes, mimeType, asset: record, title: String(file.file_name) };
}
