import { describe, expect, it } from 'vitest';
import { validateVisualImage, renderPdfPage } from './visual-renderer';
import { MAX_VISUAL_BYTES } from './visual-types';

function png(width: number, height: number) {
  const b = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return new Uint8Array(b);
}
describe('visual decoding limits', () => {
  it('recognizes PNG dimensions and rejects MIME mismatch', () => {
    expect(validateVisualImage(png(800, 600), 'image/png')).toBe('image/png');
    expect(() => validateVisualImage(png(800, 600), 'image/jpeg')).toThrow('mismatch');
  });
  it('rejects byte/pixel bombs and active or unsupported formats', () => {
    expect(() => validateVisualImage(png(10000, 10000))).toThrow('pixel');
    expect(() => validateVisualImage(png(0, 10))).toThrow('pixel');
    expect(() => validateVisualImage(new Uint8Array(MAX_VISUAL_BYTES + 1))).toThrow('byte');
    expect(() => validateVisualImage(new TextEncoder().encode('<svg/>'))).toThrow('Unsupported');
  });
  it('rejects invalid page input without launching a subprocess', async () => {
    await expect(renderPdfPage(new Uint8Array(), 0)).rejects.toThrow('page');
    await expect(renderPdfPage(new Uint8Array(), 201)).rejects.toThrow('page');
  });
});
