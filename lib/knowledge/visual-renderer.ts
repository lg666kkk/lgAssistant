import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_VISUAL_BYTES } from './visual-types';

/** Poppler runs without a shell, on a private temporary copy, with a hard deadline. */
export async function renderPdfPage(bytes: Uint8Array, page: number, signal?: AbortSignal) {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new Error('Invalid PDF page');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-page-'));
  try {
    const source = path.join(dir, 'source.pdf');
    const target = path.join(dir, 'page');
    await writeFile(source, bytes, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      execFile(process.env.RAG_PDF_RENDER_BIN || 'pdftoppm', [
        '-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2000',
        '-r', '144', '-png', source, target,
      ], { timeout: 30_000, maxBuffer: 64 * 1024, signal }, (error) => {
        if (error) reject(new Error(signal?.aborted ? 'PDF rendering cancelled' : 'PDF rendering failed; check Poppler installation'));
        else resolve();
      });
    });
    const image = await readFile(`${target}.png`);
    if (image.length > MAX_VISUAL_BYTES) throw new Error('Rendered page exceeds image budget');
    return new Uint8Array(image);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function validateVisualImage(bytes: Uint8Array, claimedMime?: string): 'image/png' | 'image/jpeg' {
  if (!bytes.length || bytes.length > MAX_VISUAL_BYTES) throw new Error('Image exceeds byte budget');
  let mime: 'image/png' | 'image/jpeg';
  let width: number;
  let height: number;
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b[0] === 255 && b[1] === 216) {
    mime = 'image/jpeg'; width = 0; height = 0;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i++] !== 255) break;
      let marker = b[i++];
      while (marker === 255 && i < b.length) marker = b[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const size = b.readUInt16BE(i);
      if (size < 2 || i + size > b.length) break;
      if ([192, 193, 194].includes(marker) && size >= 7) {
        height = b.readUInt16BE(i + 3); width = b.readUInt16BE(i + 5); break;
      }
      i += size;
    }
  } else throw new Error('Unsupported image format; only PNG/JPEG are accepted');
  if (claimedMime && claimedMime !== mime) throw new Error('Image MIME signature mismatch');
  if (!width || !height || width > 10000 || height > 10000 || width * height > 16_000_000) {
    throw new Error('Image exceeds pixel budget');
  }
  return mime;
}
