import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function ocrKnowledgeImage(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-image-ocr-'));
  try {
    const imagePath = path.join(dir, 'image.jpg');
    await writeFile(imagePath, bytes, { mode: 0o600 });
    return await new Promise<string>((resolve, reject) => {
      execFile(process.env.RAG_OCR_BIN || 'tesseract', [imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' } },
        (error, stdout) => error
          ? reject(new Error('图片 OCR 失败，请检查 Tesseract 和中英文语言包，或启用视觉索引'))
          : resolve(stdout.trim()));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
