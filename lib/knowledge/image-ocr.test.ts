import { stat } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { ocrKnowledgeImage } from './image-ocr';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: exec }));
beforeEach(() => { exec.mockReset(); });

it.each([false, true])('cleans temporary images after OCR (failure=%s)', async (failure) => {
  exec.mockImplementation((_binary, _args, _options, callback) => callback(failure ? new Error('missing OCR') : null, ' 中文 text\n'));
  const pending = ocrKnowledgeImage(new Uint8Array([1, 2, 3]));
  if (failure) await expect(pending).rejects.toThrow('图片 OCR 失败');
  else expect(await pending).toBe('中文 text');
  const [, args, options] = exec.mock.calls[0];
  expect(args.slice(1)).toEqual(['stdout', '-l', 'chi_sim+eng', '--psm', '3']);
  expect(options).toMatchObject({ timeout: 60_000, env: { OMP_THREAD_LIMIT: '1' } });
  await expect(stat(path.dirname(args[0]))).rejects.toMatchObject({ code: 'ENOENT' });
});
