import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_PDF_MAX_PAGES, parseKnowledgeFile } from './file-parsers';

const pdf = vi.hoisted(() => ({
  destroy: vi.fn(),
  extractText: vi.fn(),
  numPages: 2,
  ocr: vi.fn(),
}));

vi.mock('./pdf-ocr', () => ({ ocrPdfPages: pdf.ocr }));

vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => ({ numPages: pdf.numPages, loadingTask: { destroy: pdf.destroy } })),
  extractText: pdf.extractText,
}));

describe('PDF resource lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdf.numPages = 2;
    pdf.destroy.mockResolvedValue(undefined);
    pdf.extractText.mockResolvedValue({ text: ['First page', 'Second page'] });
    pdf.ocr.mockResolvedValue(['', '']);
  });

  const input = { fileName: 'report.pdf', kind: 'pdf' as const, bytes: new Uint8Array([37, 80, 68, 70]) };

  it('releases the document after successful extraction', async () => {
    expect((await parseKnowledgeFile(input)).content).toBe('First page\n\nSecond page');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('releases the document when extraction throws', async () => {
    pdf.extractText.mockRejectedValueOnce(new Error('invalid PDF stream'));
    await expect(parseKnowledgeFile(input)).rejects.toThrow('invalid PDF stream');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('releases a scanned document before rejecting its empty text', async () => {
    pdf.extractText.mockResolvedValueOnce({ text: ['', ''] });
    await expect(parseKnowledgeFile(input)).rejects.toThrow('扫描件');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });
  it('preserves empty physical pages when visual capture is enabled', async () => {
    pdf.extractText.mockResolvedValueOnce({ text: ['', ''] });
    const parsed = await parseKnowledgeFile({ ...input, captureVisuals: true });
    expect(parsed.content).toBe('');
    expect(parsed.visuals?.map((v) => v.pageNumber)).toEqual([1, 2]);
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('releases the PDF before starting OCR and reports missing OCR dependencies', async () => {
    pdf.extractText.mockResolvedValueOnce({ text: ['', ''] });
    pdf.ocr.mockImplementationOnce(async () => {
      expect(pdf.destroy).toHaveBeenCalledTimes(1);
      throw new Error('OCR unavailable');
    });
    await expect(parseKnowledgeFile(input)).rejects.toThrow('OCR unavailable');
  });

  it('can fall back to visual indexing when OCR fails', async () => {
    pdf.extractText.mockResolvedValueOnce({ text: ['', ''] });
    pdf.ocr.mockRejectedValueOnce(new Error('OCR unavailable'));
    const parsed = await parseKnowledgeFile({ ...input, captureVisuals: true });
    expect(parsed.visuals).toHaveLength(2);
    expect(parsed.warnings).toEqual(['OCR unavailable']);
  });

  it('rejects excessive page counts before text extraction and releases the document', async () => {
    pdf.numPages = KNOWLEDGE_PDF_MAX_PAGES + 1;
    await expect(parseKnowledgeFile(input)).rejects.toThrow('200 页上限');
    expect(pdf.extractText).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('allows a document at the page-count limit', async () => {
    pdf.numPages = KNOWLEDGE_PDF_MAX_PAGES;
    await expect(parseKnowledgeFile(input)).resolves.toHaveProperty('content');
    expect(pdf.extractText).toHaveBeenCalledTimes(1);
  });
});
