import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mocks = vi.hoisted(() => ({ user: vi.fn(), text: vi.fn(), signedUrl: vi.fn() }));
vi.mock('@/lib/auth/server', () => ({ requireUser: mocks.user }));
vi.mock('@/lib/knowledge/files', () => ({
  readKnowledgeTextFile: mocks.text,
  createKnowledgeFileSignedUrl: mocks.signedUrl,
  deleteKnowledgeFile: vi.fn(),
  filePageId: vi.fn(),
}));
vi.mock('@/lib/agent/tools/knowledge-profile', () => ({ enqueueKnowledgeProfileRefresh: vi.fn() }));
vi.mock('@/lib/knowledge/ingestion-queue', () => ({ enqueueRagIngestionJob: vi.fn() }));
vi.mock('@/lib/platform/supabase', () => ({ getSupabase: vi.fn() }));

const context = { params: { id: '00000000-0000-4000-8000-000000000002' } };
const request = new Request('http://localhost/api/knowledge/files/' + context.params.id);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'owner' });
});

describe('file preview encoding', () => {
  it('serves Chinese and HTML source as UTF-8 plain text', async () => {
    const content = '# 中文标题\n<script>alert(1)</script>';
    mocks.text.mockResolvedValue({ fileName: '中文.html', bytes: new TextEncoder().encode(content) });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe(content);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  it('still redirects binary files', async () => {
    mocks.text.mockResolvedValue(null);
    mocks.signedUrl.mockResolvedValue('https://example.com/file.pdf');
    const response = await GET(request, context);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/file.pdf');
  });

  it('requires authentication before reading the file', async () => {
    mocks.user.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    expect((await GET(request, context)).status).toBe(401);
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
