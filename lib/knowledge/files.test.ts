import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAllKnowledgeFiles, deleteKnowledgeFile, syncKnowledgeFile } from './files';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), remove: vi.fn(), download: vi.fn(), index: vi.fn(),
}));

vi.mock('@/lib/platform/supabase', () => ({
  getSupabase: () => ({
    rpc: mocks.rpc, from: mocks.from,
    storage: { from: () => ({ remove: mocks.remove, download: mocks.download }) },
  }),
}));
vi.mock('./sync', () => ({
  indexSourceDocument: mocks.index,
  failedSyncResult: (pageId: string, _options: unknown, error: Error) => ({
    pageId, success: false, status: 'failed', error: error.message,
  }),
}));

const userId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const record = {
  id: fileId, user_id: userId, file_name: 'report.txt', file_kind: 'text',
  storage_path: `${userId}/${fileId}/source.txt`, created_at: '2026-10-02T00:00:00Z',
};

function metadataQuery() {
  const query = {
    select: vi.fn(), eq: vi.fn(), order: vi.fn(), maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.from.mockReturnValue(query);
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.remove.mockResolvedValue({ error: null });
});

describe('atomic file deletion', () => {
  it('cleans storage only after a committed database deletion', async () => {
    mocks.rpc.mockResolvedValue({ data: record.storage_path, error: null });
    expect(await deleteKnowledgeFile(userId, fileId)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('delete_knowledge_file_atomic', {
      p_user_id: userId, p_file_id: fileId,
    });
    expect(mocks.remove).toHaveBeenCalledWith([record.storage_path]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('preserves storage if the database transaction fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'transaction aborted' } });
    await expect(deleteKnowledgeFile(userId, fileId)).rejects.toThrow('transaction aborted');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('returns false for an absent or unowned file', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await deleteKnowledgeFile(userId, fileId)).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('uses atomic deletion for every file during a knowledge reset', async () => {
    const query = metadataQuery();
    const second = { ...record, id: '00000000-0000-4000-8000-000000000003' };
    query.order.mockResolvedValue({ data: [record, second], error: null });
    mocks.rpc.mockResolvedValueOnce({ data: record.storage_path, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await deleteAllKnowledgeFiles(userId)).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.remove).toHaveBeenCalledWith([record.storage_path]);
  });

  it('cleans already deleted objects even if a later reset transaction fails', async () => {
    const query = metadataQuery();
    query.order.mockResolvedValue({ data: [record, { ...record, id: '00000000-0000-4000-8000-000000000003' }], error: null });
    mocks.rpc.mockResolvedValueOnce({ data: record.storage_path, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'transaction aborted' } });
    await expect(deleteAllKnowledgeFiles(userId)).rejects.toThrow('transaction aborted');
    expect(mocks.remove).toHaveBeenCalledWith([record.storage_path]);
  });
});

describe('file deletion during ingestion', () => {
  it('skips a file deleted while the worker was preparing its index', async () => {
    const query = metadataQuery();
    query.maybeSingle.mockResolvedValueOnce({ data: record, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    mocks.download.mockResolvedValue({ data: new Blob(['Report contents']), error: null });
    mocks.index.mockRejectedValue(new Error('knowledge file no longer exists'));
    expect(await syncKnowledgeFile(fileId, { userId })).toMatchObject({
      success: true, status: 'skipped', chunksCount: 0,
    });
  });

  it('keeps an indexing failure retryable while the file still exists', async () => {
    const query = metadataQuery();
    query.maybeSingle.mockResolvedValue({ data: record, error: null });
    mocks.download.mockResolvedValue({ data: new Blob(['Report contents']), error: null });
    mocks.index.mockRejectedValue(new Error('embedding unavailable'));
    expect(await syncKnowledgeFile(fileId, { userId })).toMatchObject({
      success: false, status: 'failed', error: 'embedding unavailable',
    });
  });

  it('does not mistake a metadata lookup error for a deleted file', async () => {
    const query = metadataQuery();
    query.maybeSingle.mockResolvedValueOnce({ data: record, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } });
    mocks.download.mockResolvedValue({ data: new Blob(['Report contents']), error: null });
    mocks.index.mockRejectedValue(new Error('embedding unavailable'));
    expect(await syncKnowledgeFile(fileId, { userId })).toMatchObject({
      success: false, status: 'failed', error: 'embedding unavailable',
    });
  });
});
