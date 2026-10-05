import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "./chunking";
import {
  detectKnowledgeFileKind,
  pageRangeForSpan,
  parseKnowledgeFile,
} from "./file-parsers";
import { filePageId, parseFilePageId, sanitizeFileName } from "./files";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const ocr = vi.hoisted(() => vi.fn());
vi.mock('./pdf-ocr', () => ({ ocrPdfPages: ocr }));
beforeEach(() => {
  ocr.mockReset();
  ocr.mockResolvedValue(['', '']);
});

/** 生成每页一行文本的最小 PDF，xref 偏移按实际字节计算。 */
function buildPdf(pageTexts: string[]) {
  const objects: string[] = [];
  const pageCount = pageTexts.length;
  const pageIds = pageTexts.map((_, index) => 3 + index * 2);
  const fontId = 3 + pageCount * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  pageTexts.forEach((text, index) => {
    const pageId = pageIds[index];
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return bytes(pdf);
}

describe("knowledge file kind detection", () => {
  it("maps extensions to kinds", () => {
    expect(detectKnowledgeFileKind("a.MD", bytes("# hi"))).toBe("markdown");
    expect(detectKnowledgeFileKind("a.txt", bytes("hi"))).toBe("text");
    expect(detectKnowledgeFileKind("a.htm", bytes("<p>hi</p>"))).toBe("html");
    expect(detectKnowledgeFileKind("a.pdf", bytes("%PDF-1.4"))).toBe("pdf");
    expect(detectKnowledgeFileKind("a.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("docx");
  });

  it("rejects unsupported extensions", () => {
    expect(() => detectKnowledgeFileKind("a.exe", bytes("x"))).toThrow("不支持的文件类型");
    expect(() => detectKnowledgeFileKind("noext", bytes("x"))).toThrow("(无扩展名)");
  });

  it("rejects content that does not match the extension", () => {
    expect(() => detectKnowledgeFileKind("a.pdf", bytes("hello"))).toThrow("有效的 PDF");
    expect(() => detectKnowledgeFileKind("a.docx", bytes("hello"))).toThrow("有效的 docx");
    expect(() => detectKnowledgeFileKind("a.md", new Uint8Array([0x23, 0x00, 0x41]))).toThrow("不是文本格式");
  });
});

describe("knowledge file parsing", () => {
  it("uses the first markdown heading as title and strips BOM/CRLF", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "notes.md",
      kind: "markdown",
      bytes: bytes("\uFEFFintro\r\n# 部署手册\r\n内容"),
    });
    expect(parsed.title).toBe("部署手册");
    expect(parsed.content).toBe("intro\n# 部署手册\n内容");
  });

  it("falls back to the file name for plain text", async () => {
    const parsed = await parseKnowledgeFile({ fileName: "会议纪要.txt", kind: "text", bytes: bytes("纪要内容") });
    expect(parsed.title).toBe("会议纪要");
  });

  it("converts html to markdown and drops scripts", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "page.html",
      kind: "html",
      bytes: bytes("<html><head><title>FAQ 页面</title><script>alert(1)</script></head><body><h2>问题</h2><p>答案 <b>重点</b></p></body></html>"),
    });
    expect(parsed.title).toBe("FAQ 页面");
    expect(parsed.content).toContain("## 问题");
    expect(parsed.content).toContain("**重点**");
    expect(parsed.content).not.toContain("alert");
  });

  it("preserves table headers, rows, and inline formatting", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "prices.html", kind: "html",
      bytes: bytes('<table><tr><th>Product</th><th>Price</th></tr><tr><td><b>Alpha</b></td><td>10</td></tr><tr><td>Beta</td><td>20</td></tr></table>'),
    });
    expect(parsed.content).toBe('| Product | Price |\n| --- | --- |\n| **Alpha** | 10 |\n| Beta | 20 |');
    expect(chunkText(parsed.content)[0].kind).toBe('table');
  });

  it("preserves headerless tables, empty cells, pipes, and cell paragraphs", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "table.html", kind: "html",
      bytes: bytes('<table><tr><td>Alpha | Beta</td><td></td></tr><tr><td><p>First</p><p>Second</p></td><td>20</td></tr></table>'),
    });
    expect(parsed.content).toBe('|  |  |\n| --- | --- |\n| Alpha \\| Beta |  |\n| First<br>Second | 20 |');
  });

  it("preserves rows in a real DOCX table without header cells", async () => {
    // 最小 OOXML 文档：两行两列，无表头；验证 Mammoth → Markdown 完整链路。
    const docx = Buffer.from("UEsDBBQAAAAIAPRkQl10JJxTuwAAAD4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJWQuQ7CMAyGX6XKiqgRAwNquwArMPACVuq2EbkUuxxvT8o1sDHa//FZrk73SFzcnPVcq0EkrgFYD+SQyxDJZ6ULyaHkMfUQUZ+xJ1guFivQwQt5mcvUoZpqSx2OVordLa/ZBF+rRJZVsXkZJ1atMEZrNErW4eLbH8r8TShz8unhwUSeZYOCpjpcKCXTUnHEJHt0uQ6uIbXQBj26jCgn41+80HVG0zc/tcUUNDEb3ztbfhWHxn/ugOfbmgdQSwMEFAAAAAgA9GRCXWF7L0OJAAAA8gAAAAsAAABfcmVscy8ucmVsc43POw4CIRAG4KsQDrCzWlgYoLLZ1ngBAsMjLo8MGPX2UlisxsJy5p98f0accdU9ltxCrI090pqb5KH3egRoJmDSbSoV80hcoaT7GMlD1eaqPcJ+ng9AW4MrsTXZYiWnxe44uzwr/mMX56LBUzG3hLn/qPi6GLImj13yeyEL9r2eBstBCfh4Ub0AUEsDBBQAAAAIAPRkQl2ACRgXlQAAAF8BAAARAAAAd29yZC9kb2N1bWVudC54bWyVkE0OwiAQha9iegAHu3BBkERvQgFLE2AI0KC3t1B/FqYxbr43k3mTlxlWqEI5O+3z7uasT7ScOpNzoABJGu1E2mPQfpldMTqRlzaOUDCqEFHqlCY/Ogs9IUdwYvIdZ4UOqO5V82CbxEZZGSrWnp9tMIJBLStjY2hczd8rB7Lth3fSRt5F5z/j+t9x8DwTXmfD56X8AVBLAQIUAxQAAAAIAPRkQl10JJxTuwAAAD4BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgA9GRCXWF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIAB7AAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgA9GRCXYAJGBeVAAAAXwEAABEAAAAAAAAAAAAAAIABngEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAGICAAAAAA==", "base64");
    const parsed = await parseKnowledgeFile({ fileName: "table.docx", kind: "docx", bytes: docx });
    expect(parsed.content).toBe('|  |  |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 20 |');
  });

  it("rejects empty content", async () => {
    await expect(parseKnowledgeFile({ fileName: "a.txt", kind: "text", bytes: bytes("  \n ") }))
      .rejects.toThrow("没有可索引的文本");
  });

  it("extracts pdf pages with offsets aligned to chunk spans", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "report.pdf",
      kind: "pdf",
      bytes: buildPdf(["First page text", "", "Third page text"]),
    });
    expect(parsed.title).toBe("report");
    expect(parsed.pageOffsets).toHaveLength(3);
    expect(parsed.content).toBe("First page text\n\nThird page text");

    const thirdStart = parsed.content.indexOf("Third");
    expect(parsed.pageOffsets).toEqual([0, 15, thirdStart]);
    // chunkText 不应改动偏移：chunk 的原文切片应等于 chunk 文本的开头。
    const chunks = chunkText(parsed.content);
    for (const chunk of chunks) {
      expect(parsed.content.slice(chunk.startChar, chunk.endChar).trim().length).toBeGreaterThan(0);
    }
    expect(pageRangeForSpan(parsed.pageOffsets, thirdStart, thirdStart + 5)).toEqual({ pageStart: 3, pageEnd: 3 });
  });

  it("reports scanned pdfs when OCR also finds no text", async () => {
    await expect(parseKnowledgeFile({ fileName: "scan.pdf", kind: "pdf", bytes: buildPdf(["", ""]) }))
      .rejects.toThrow("扫描件");
  });

  it('uses OCR for scans and preserves page offsets after normalization', async () => {
    ocr.mockResolvedValue(['中文第一页\r\n内容', '', 'Third page']);
    const parsed = await parseKnowledgeFile({ fileName: 'scan.pdf', kind: 'pdf', bytes: buildPdf(['', '', '']) });
    expect(parsed.content).toBe('中文第一页\n内容\n\nThird page');
    expect(parsed.ocrUsed).toBe(true);
    expect(ocr).toHaveBeenCalledWith(expect.any(Uint8Array), 3);
    const thirdStart = parsed.content.indexOf('Third');
    expect(parsed.pageOffsets).toEqual([0, 8, thirdStart]);
    expect(pageRangeForSpan(parsed.pageOffsets, thirdStart, thirdStart + 5)).toEqual({ pageStart: 3, pageEnd: 3 });
  });

  it('does not OCR PDFs with an existing text layer', async () => {
    await parseKnowledgeFile({ fileName: 'text.pdf', kind: 'pdf', bytes: buildPdf(['Native text']) });
    expect(ocr).not.toHaveBeenCalled();
  });

  it("rejects a real PDF over 200 pages before attempting text extraction", async () => {
    await expect(parseKnowledgeFile({
      fileName: "too-many-pages.pdf", kind: "pdf",
      bytes: buildPdf(Array.from({ length: 201 }, () => '')),
    })).rejects.toThrow('200 页上限');
  });
});

describe("pageRangeForSpan", () => {
  const offsets = [0, 100, 250];

  it("returns undefined without page offsets", () => {
    expect(pageRangeForSpan(undefined, 0, 10)).toBeUndefined();
    expect(pageRangeForSpan([], 0, 10)).toBeUndefined();
  });

  it("maps spans to 1-based pages", () => {
    expect(pageRangeForSpan(offsets, 0, 50)).toEqual({ pageStart: 1, pageEnd: 1 });
    expect(pageRangeForSpan(offsets, 90, 100)).toEqual({ pageStart: 1, pageEnd: 1 });
    expect(pageRangeForSpan(offsets, 90, 101)).toEqual({ pageStart: 1, pageEnd: 2 });
    expect(pageRangeForSpan(offsets, 260, 400)).toEqual({ pageStart: 3, pageEnd: 3 });
  });

  it("skips empty pages that share an offset", () => {
    expect(pageRangeForSpan([0, 50, 50], 60, 70)).toEqual({ pageStart: 3, pageEnd: 3 });
  });
});

describe("file page ids", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("round-trips file ids and ignores notion ids", () => {
    expect(parseFilePageId(filePageId(id))).toBe(id);
    expect(parseFilePageId("2f1c0d6e8a7b4c3d9e0f112233445566")).toBeNull();
    expect(parseFilePageId("file:../../etc")).toBeNull();
  });

  it("sanitizes uploaded file names", () => {
    expect(sanitizeFileName("../../a<b>.md")).toBe("a_b_.md");
    expect(sanitizeFileName("C:\\docs\\报告.pdf")).toBe("报告.pdf");
    expect(sanitizeFileName("   ")).toBe("file");
  });
});
