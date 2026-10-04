import { KNOWLEDGE_FILE_MAX_BYTES } from './file-parsers';

// 包括 file、其他表单字段及 multipart 边界的总请求大小。
export const KNOWLEDGE_UPLOAD_MAX_BODY_BYTES = KNOWLEDGE_FILE_MAX_BYTES + 1024 * 1024;

export class KnowledgeUploadSizeError extends Error {}

export async function readKnowledgeUploadForm(req: Request): Promise<FormData> {
  if (Number(req.headers.get('content-length')) > KNOWLEDGE_UPLOAD_MAX_BODY_BYTES) {
    void req.body?.cancel().catch(() => undefined);
    throw new KnowledgeUploadSizeError('上传请求超过 21MB 上限');
  }
  let received = 0;
  const limitedBody = req.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > KNOWLEDGE_UPLOAD_MAX_BODY_BYTES) {
        // 流出错会取消上游；超限 chunk 不会进入 multipart 解析器。
        throw new KnowledgeUploadSizeError('上传请求超过 21MB 上限');
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limitedBody, {
    headers: { 'content-type': req.headers.get('content-type') ?? '' },
  }).formData();
}
