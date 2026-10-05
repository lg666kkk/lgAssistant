import { stat } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ocrPdfPages } from './pdf-ocr';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), render: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('./visual-renderer', () => ({ renderPdfPage: mocks.render }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.render.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '中文 text\n'));
  });
});

describe('PDF OCR execution', () => {
  it('recognizes pages in order with bounded resources and removes temporary images', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    expect(await ocrPdfPages(bytes, 2)).toEqual(['中文 text\n', '中文 text\n']);
    expect(mocks.render.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    const [binary, args, options] = mocks.exec.mock.calls[0];
    expect(binary).toBe(process.env.RAG_OCR_BIN || 'tesseract');
    expect(args.slice(1)).toEqual(['stdout', '-l', 'chi_sim+eng', '--psm', '3']);
    expect(options).toMatchObject({ timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { OMP_THREAD_LIMIT: '1' } });
    await expect(stat(path.dirname(args[0]))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an OCR failure without returning partial content and cleans its directory', async () => {
    mocks.exec.mockImplementationOnce((_binary, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('missing language pack'), ''));
    });
    await expect(ocrPdfPages(new Uint8Array(), 2)).rejects.toThrow('第 1 页 OCR 失败');
    const imagePath = mocks.exec.mock.calls[0][1][0];
    await expect(stat(path.dirname(imagePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it('does not launch OCR if rendering fails', async () => {
    mocks.render.mockRejectedValueOnce(new Error('PDF rendering failed'));
    await expect(ocrPdfPages(new Uint8Array(), 1)).rejects.toThrow('PDF rendering failed');
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('rejects page counts outside the PDF limit before doing any work', async () => {
    for (const count of [0, 201, 1.5]) {
      await expect(ocrPdfPages(new Uint8Array(), count)).rejects.toThrow('200 页');
    }
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});
