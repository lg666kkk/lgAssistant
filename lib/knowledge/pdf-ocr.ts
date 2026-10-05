import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderPdfPage } from './visual-renderer';

const MAX_OCR_CHARS = 2_000_000;
const OCR_TIMEOUT_MS = 10 * 60_000;

export async function ocrPdfPages(bytes: Uint8Array, pageCount: number): Promise<string[]> {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 200) {
    throw new Error('PDF OCR 页数必须在 1 到 200 页之间');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-ocr-'));
  const signal = AbortSignal.timeout(OCR_TIMEOUT_MS);
  const pages: string[] = [];
  let totalChars = 0;
  try {
    // One page at a time bounds image memory and CPU usage for long scans.
    for (let page = 1; page <= pageCount; page++) {
      signal.throwIfAborted();
      const image = await renderPdfPage(bytes, page, signal);
      const imagePath = path.join(dir, 'page.png');
      await writeFile(imagePath, image, { mode: 0o600 });
      const text = await new Promise<string>((resolve, reject) => {
        execFile(process.env.RAG_OCR_BIN || 'tesseract', [
          imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '3',
        ], {
          timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal,
          env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        }, (error, stdout) => {
          if (error) {
            reject(new Error(signal.aborted
              ? 'PDF OCR 超时，请拆分文件后重试'
              : `PDF 第 ${page} 页 OCR 失败，请检查 Tesseract 和中英文语言包是否已安装`));
          } else resolve(stdout);
        });
      });
      totalChars += text.length;
      if (totalChars > MAX_OCR_CHARS) throw new Error('PDF OCR 文本超过 200 万字符上限');
      pages.push(text);
    }
    return pages;
  } catch (error) {
    if (signal.aborted) throw new Error('PDF OCR 超时，请拆分文件后重试');
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
