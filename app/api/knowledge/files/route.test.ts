import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_FILE_MAX_BYTES } from '@/lib/knowledge/file-parsers';
import { KNOWLEDGE_UPLOAD_MAX_BODY_BYTES } from '@/lib/knowledge/upload-body';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), upload: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/auth/server', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/knowledge/files', () => ({
  uploadKnowledgeFile: mocks.upload,
  filePageId: (id: string) => `file:${id}`,
  listKnowledgeFiles: vi.fn(),
  KnowledgeFileError: class extends Error {},
}));
vi.mock('@/lib/knowledge/ingestion-queue', () => ({ enqueueRagIngestionJob: mocks.enqueue }));
vi.mock('@/lib/platform/supabase', () => ({ getSupabase: vi.fn() }));
import { POST } from './route';

function streamingRequest(headers: Record<string, string> = {}) {
  let produced = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++;
      // 100MB 请求：检查达到上限后会停止，而不是读完再拒绝。
      if (produced <= 100) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
    cancel,
  });
  const req = new Request('http://localhost/api/knowledge/files', {
    method: 'POST', body: stream,
    headers: { 'content-type': 'multipart/form-data; boundary=test', ...headers },
    duplex: 'half',
  } as RequestInit);
  return { req, cancel, produced: () => produced };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: 'user-1' });
  mocks.upload.mockResolvedValue({ file: { id: 'file-1', file_name: 'note.txt', file_kind: 'text', size_bytes: 5 }, duplicate: false });
  mocks.enqueue.mockResolvedValue({ id: 'job-1' });
});

describe('knowledge upload body limits', () => {
  const headerCases: Record<string, string>[] = [{}, { 'content-length': '1' }];
  it.each(headerCases)('limits streamed bodies with missing or false Content-Length: %j', async (headers) => {
    const request = streamingRequest(headers);
    const response = await POST(request.req);
    expect(response.status).toBe(413);
    await vi.waitFor(() => expect(request.cancel).toHaveBeenCalled());
    expect(request.produced()).toBeLessThan(100);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized body before reading it', async () => {
    const request = streamingRequest({ 'content-length': String(KNOWLEDGE_UPLOAD_MAX_BODY_BYTES + 1) });
    expect((await POST(request.req)).status).toBe(413);
    expect(request.cancel).toHaveBeenCalled();
    expect(request.produced()).toBeLessThanOrEqual(1);
  });

  it('counts extra multipart fields toward the request limit', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'note.txt'));
    form.append('extra', 'x'.repeat(KNOWLEDGE_UPLOAD_MAX_BODY_BYTES));
    expect((await POST(new Request('http://localhost/api/knowledge/files', { method: 'POST', body: form }))).status).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects files above 20MB even when the body is below 21MB', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(KNOWLEDGE_FILE_MAX_BYTES + 1)], 'large.txt'));
    expect((await POST(new Request('http://localhost/api/knowledge/files', { method: 'POST', body: form }))).status).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('accepts a normal multipart upload and enqueues ingestion', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'note.txt'));
    expect((await POST(new Request('http://localhost/api/knowledge/files', { method: 'POST', body: form }))).status).toBe(202);
    expect(mocks.upload).toHaveBeenCalledWith({ userId: 'user-1', fileName: 'note.txt', bytes: new TextEncoder().encode('hello') });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts a file exactly at the 20MB boundary with multipart overhead', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(KNOWLEDGE_FILE_MAX_BYTES)], 'boundary.txt'));
    expect((await POST(new Request('http://localhost/api/knowledge/files', { method: 'POST', body: form }))).status).toBe(202);
    expect(mocks.upload.mock.calls[0][0].bytes.byteLength).toBe(KNOWLEDGE_FILE_MAX_BYTES);
  });

  it('keeps malformed multipart requests as 400 errors', async () => {
    expect((await POST(new Request('http://localhost/api/knowledge/files', { method: 'POST', body: 'invalid' }))).status).toBe(400);
  });
});
