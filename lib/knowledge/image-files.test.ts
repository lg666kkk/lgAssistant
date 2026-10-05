import sharp from 'sharp';
import bmp from 'bmp-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeImageMime, normalizeKnowledgeImage } from './image-files';
import { detectKnowledgeFileKind, parseKnowledgeFile } from './file-parsers';
import { validateVisualImage } from './visual-renderer';

const ocr = vi.hoisted(() => vi.fn());
vi.mock('./image-ocr', () => ({ ocrKnowledgeImage: ocr }));
beforeEach(() => { ocr.mockReset(); ocr.mockResolvedValue('图片中的中文 text'); });

async function fixture(format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff') {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: '#ff0000' } }).toFormat(format).toBuffer();
}

describe('knowledge image ingestion', () => {
  it.each(['png', 'jpeg', 'webp', 'gif', 'tiff'] as const)('decodes %s and normalizes it for OCR and vision', async (format) => {
    const source = await fixture(format);
    const fileName = `图片.${format}`;
    expect(detectKnowledgeFileKind(fileName, source)).toBe('image');
    const normalized = await normalizeKnowledgeImage(source, knowledgeImageMime(fileName, source));
    expect(validateVisualImage(normalized)).toBe('image/jpeg');
    const parsed = await parseKnowledgeFile({ fileName, kind: 'image', bytes: source });
    expect(parsed).toMatchObject({ content: '图片中的中文 text', ocrUsed: true });
    expect(parsed.visuals).toBeUndefined();
  });

  it('decodes BMP with correct color channels', async () => {
    const source = bmp.encode({ width: 2, height: 2, data: Buffer.from(Array(4).fill([0, 0, 0, 255]).flat()) }).data;
    const normalized = await normalizeKnowledgeImage(source, knowledgeImageMime('red.bmp', source));
    const pixel = await sharp(normalized).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(240);
    expect(pixel[1]).toBeLessThan(15);
    expect(pixel[2]).toBeLessThan(15);
  });

  it('accepts JPG/TIF aliases but rejects mismatched or executable content', async () => {
    expect(knowledgeImageMime('a.JPG', await fixture('jpeg'))).toBe('image/jpeg');
    expect(knowledgeImageMime('a.tif', await fixture('tiff'))).toBe('image/tiff');
    expect(() => knowledgeImageMime('a.jpg', Buffer.from('<script>bad</script>'))).toThrow('不匹配');
    expect(() => knowledgeImageMime('a.png', Buffer.from('GIF89a'))).toThrow('不匹配');
  });

  it('does not index a filename as image content when OCR finds no text', async () => {
    ocr.mockResolvedValue('');
    const bytes = await fixture('png');
    await expect(parseKnowledgeFile({ fileName: 'photo.png', kind: 'image', bytes })).rejects.toThrow('启用视觉索引');
    const parsed = await parseKnowledgeFile({ fileName: 'photo.png', kind: 'image', bytes, captureVisuals: true });
    expect(parsed.content).toBe('');
    expect(parsed.visuals).toHaveLength(1);
    expect(parsed.visuals![0]).toMatchObject({ kind: 'embedded_image', mimeType: 'image/jpeg', occurrenceKey: 'image-1' });
  });

  it('allows explicitly enabled vision to continue after an OCR failure', async () => {
    ocr.mockRejectedValue(new Error('OCR unavailable'));
    const bytes = await fixture('png');
    await expect(parseKnowledgeFile({ fileName: 'a.png', kind: 'image', bytes })).rejects.toThrow('OCR unavailable');
    const parsed = await parseKnowledgeFile({ fileName: 'a.png', kind: 'image', bytes, captureVisuals: true });
    expect(parsed.warnings).toContain('OCR unavailable');
    expect(parsed.visuals).toHaveLength(1);
  });

  it('rejects oversized pixel declarations before BMP allocation', async () => {
    const b = Buffer.alloc(54);
    b.write('BM'); b.writeUInt32LE(40, 14); b.writeInt32LE(10000, 18); b.writeInt32LE(10000, 22);
    await expect(normalizeKnowledgeImage(b, 'image/bmp')).rejects.toThrow('像素限制');
  });
});
