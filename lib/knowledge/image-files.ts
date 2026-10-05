import path from 'node:path';
import sharp from 'sharp';
import bmp from 'bmp-js';
import { validateVisualImage } from './visual-renderer';

export const KNOWLEDGE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'];
const MAX_PIXELS = 16_000_000;

export function knowledgeImageMime(fileName: string, bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  const extension = path.extname(fileName).toLowerCase();
  const expected: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
  };
  let mime = '';
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
  else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (b.toString('ascii', 0, 2) === 'BM') mime = 'image/bmp';
  else if (['49492a00', '4d4d002a'].includes(b.subarray(0, 4).toString('hex'))) mime = 'image/tiff';
  if (!mime || expected[extension] !== mime) throw new Error('图片内容与扩展名不匹配，或图片格式不受支持');
  return mime;
}

/** Decode locally; never execute SVG/HTML or fetch external image resources. */
export async function normalizeKnowledgeImage(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  let image;
  if (mime === 'image/bmp') {
    const b = Buffer.from(bytes);
    if (b.length < 54 || b.readUInt32LE(14) !== 40) throw new Error('暂不支持此 BMP 编码，请转换为 PNG');
    const width = b.readInt32LE(18);
    const height = Math.abs(b.readInt32LE(22));
    if (width < 1 || height < 1 || width > 10000 || height > 10000 || width * height > MAX_PIXELS) {
      throw new Error('图片超过像素限制（1600 万像素）');
    }
    const depth = b.readUInt16LE(28);
    const colors = b.readUInt32LE(46);
    const offset = b.readUInt32LE(10);
    const paletteBytes = depth <= 8 ? (colors || 2 ** depth) * 4 : 0;
    const rowBytes = Math.ceil(width * depth / 32) * 4;
    if (![1, 4, 8, 16, 24, 32].includes(depth) || b.readUInt16LE(26) !== 1
      || b.readUInt32LE(30) !== 0 || (depth <= 8 && colors > 2 ** depth)
      || offset < 54 + paletteBytes || offset + rowBytes * height > b.length) {
      throw new Error('BMP 文件损坏或编码不受支持，请转换为 PNG');
    }
    const decoded = bmp.decode(b);
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < decoded.data.length; i += 4, j += 3) {
      rgb[j] = decoded.data[i + 3]; rgb[j + 1] = decoded.data[i + 2]; rgb[j + 2] = decoded.data[i + 1];
    }
    image = sharp(rgb, { raw: { width, height, channels: 3 } });
  } else {
    image = sharp(Buffer.from(bytes), { limitInputPixels: MAX_PIXELS, pages: 1, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000) {
      throw new Error('图片尺寸超过限制');
    }
  }
  const output = await image.rotate().resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
  validateVisualImage(output, 'image/jpeg');
  return new Uint8Array(output);
}
