/**
 * 自定义文件解析：把上传文件统一转成 Markdown，交给 chunkText 按结构切块。
 */

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  cleanKnowledgeMarkdown,
  imagePlaceholder,
  type KnowledgeLink,
} from './content-cleanup';
import { validateDocxArchive } from './docx-limits';
import { MAX_VISUAL_ASSETS, MAX_VISUAL_BYTES, type ParsedVisual } from './visual-types';
import { validateVisualImage } from './visual-renderer';
import { ocrPdfPages } from './pdf-ocr';
import { KNOWLEDGE_IMAGE_EXTENSIONS, knowledgeImageMime, normalizeKnowledgeImage } from './image-files';
import { ocrKnowledgeImage } from './image-ocr';

export type KnowledgeFileKind = 'markdown' | 'text' | 'html' | 'pdf' | 'docx' | 'image';

export const KNOWLEDGE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_FILE_MAX_CHARS = 2_000_000;
export const KNOWLEDGE_PDF_MAX_PAGES = 200;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const MIME_BY_KIND: Record<KnowledgeFileKind, string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  html: 'text/html',
  pdf: 'application/pdf',
  docx: DOCX_MIME,
  image: 'image/png',
};

const KIND_BY_EXTENSION: Record<string, KnowledgeFileKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.docx': 'docx',
  ...Object.fromEntries(KNOWLEDGE_IMAGE_EXTENSIONS.map((extension) => [extension, 'image' as const])),
};

export const SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS = Object.keys(KIND_BY_EXTENSION);

export type ParsedKnowledgeFile = {
  title: string;
  content: string;
  ocrUsed?: boolean;
  /** PDF 每页在 content 中的起始字符偏移，用于给 chunk 标注页码。 */
  pageOffsets?: number[];
  /** 正文中被清理掉的安全链接，偏移对应 content，用于写入 chunk metadata。 */
  links?: KnowledgeLink[];
  visuals?: ParsedVisual[];
  warnings?: string[];
};

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function looksLikeText(bytes: Uint8Array) {
  // NUL 基本不会出现在 UTF-8 文本里，出现就当二进制处理。
  return !bytes.subarray(0, 8192).includes(0);
}

/**
 * 按扩展名判断类型，再用文件头校验，防止把二进制伪装成文本（或反过来）。
 */
export function detectKnowledgeFileKind(
  fileName: string,
  bytes: Uint8Array,
): KnowledgeFileKind {
  const extension = path.extname(fileName).toLowerCase();
  const kind = KIND_BY_EXTENSION[extension];
  if (!kind) {
    throw new Error(
      `不支持的文件类型 ${extension || '(无扩展名)'}，支持：${SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS.join(', ')}`,
    );
  }

  if (kind === 'pdf' && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    throw new Error('文件内容不是有效的 PDF');
  }
  if (kind === 'image') knowledgeImageMime(fileName, bytes);
  if (kind === 'docx' && !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new Error('文件内容不是有效的 docx');
  }
  if ((kind === 'markdown' || kind === 'text' || kind === 'html') && !looksLikeText(bytes)) {
    throw new Error('文件内容不是文本格式');
  }
  return kind;
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function inferMarkdownTitle(content: string) {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

function stripExtension(fileName: string) {
  return path.basename(fileName, path.extname(fileName)) || fileName;
}

async function htmlToMarkdown(html: string, visualImages?: Map<string, string>) {
  const { default: TurndownService } = await import('turndown');
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    blankReplacement: (content, node) => node.nodeName === 'DIV' && node.hasAttribute('data-mxgraph')
      ? drawioRule.replacement(content, node)
      : content.trim() ? content : (node as HTMLElement & { isBlock?: boolean }).isBlock ? '\n\n' : '',
  });
  turndown.remove(['script', 'style', 'noscript', 'iframe']);
  // draw.io exports store graph labels and edges in data-mxgraph, not visible HTML.
  const drawioRule = {
    filter: (node: HTMLElement) => node.nodeName === 'DIV' && node.hasAttribute('data-mxgraph'),
    replacement: (_content: string, node: HTMLElement): string => {
      try {
        const graph = JSON.parse((node as HTMLElement).getAttribute('data-mxgraph')!);
        if (typeof graph.xml !== 'string' || !graph.xml.trim()) throw new Error('Missing graph XML');
        const diagram = new TurndownService({ headingStyle: 'atx',
          blankReplacement: (content, node) => node.nodeName.toLowerCase() === 'mxgraphmodel'
            ? graphRule.replacement(content, node)
            : node.nodeName.toLowerCase() === 'diagram' ? pageRule.replacement(content, node)
            : content,
        });
        diagram.remove(['script', 'style', 'noscript', 'iframe']);
        const graphRule = {
          filter: (element: HTMLElement) => element.nodeName.toLowerCase() === 'mxgraphmodel',
          replacement: (_text: string, model: HTMLElement): string => {
            const cells = Array.from(model.querySelectorAll('mxcell'));
            const labels = new Map<string, string>();
            const labelFor = (cell: Element) => {
              const wrapper = cell.parentElement;
              const raw = cell.getAttribute('value') ?? wrapper?.getAttribute('label') ?? '';
              // Diagram editors wrap ordinary labels in pre/code. Keep each label
              // inline so chunking cannot separate an edge from its endpoints.
              return turndown.turndown(raw.replace(/<br\s*\/?\s*>/gi, ' '))
                .replace(/^```[^\n]*$/gm, '').replace(/\s+/g, ' ').trim();
            };
            for (const cell of cells) {
              if (cell.getAttribute('edge') === '1') continue;
              const label = labelFor(cell);
              const id = cell.getAttribute('id') ?? cell.parentElement?.getAttribute('id');
              if (id && label) labels.set(id, label);
            }
            const lines = ['### 图中节点', ...Array.from(labels.values(), (label) => `- ${label}`)];
            const connections: string[] = [];
            for (const cell of cells) {
              if (cell.getAttribute('edge') !== '1') continue;
              const source = labels.get(cell.getAttribute('source') ?? '');
              const target = labels.get(cell.getAttribute('target') ?? '');
              const label = labelFor(cell);
              if (source && target) {
                connections.push(`- 源节点：${source}；目标节点：${target}${label ? `；连线文字：${label}` : ''}`);
              } else if (label) lines.push(`- 连线文字：${label}`);
            }
            if (connections.length) lines.push('### 图中连接（按源节点和目标节点记录）', ...connections);
            if (!labels.size && !connections.length) throw new Error('Graph has no text');
            return `\n\n${lines.join('\n')}\n\n`;
          },
        };
        diagram.addRule('graphModel', graphRule);
        const pageRule = {
          filter: (element: HTMLElement) => element.nodeName.toLowerCase() === 'diagram',
          replacement: (content: string, page: HTMLElement): string => {
            if (!page.querySelector('mxgraphmodel')) {
              const compressed = Buffer.from(page.textContent?.trim() ?? '', 'base64');
              const xml = decodeURIComponent(inflateRawSync(compressed, {
                maxOutputLength: KNOWLEDGE_FILE_MAX_CHARS,
              }).toString('utf8'));
              if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported XML declaration');
              content = diagram.turndown(xml);
            }
            return `\n\n## ${page.getAttribute('name') || '流程图'}\n\n${content}\n\n`;
          },
        };
        diagram.addRule('diagramPage', pageRule);
        if (graph.xml.length > KNOWLEDGE_FILE_MAX_CHARS || /<!DOCTYPE|<!ENTITY/i.test(graph.xml)) {
          throw new Error('Graph XML exceeds limits or contains unsupported declarations');
        }
        const content = diagram.turndown(graph.xml);
        if (!content.trim()) throw new Error('Graph has no text');
        return `\n\n${content}\n\n`;
      } catch (cause) {
        throw new Error('无法提取 draw.io 图形内容，请重新导出 HTML 或上传含文字的 PDF', { cause });
      }
    },
  };
  turndown.addRule('knowledgeDrawio', drawioRule);
  // 图片只留 alt 占位，data: URI 和图片地址都不进入 Markdown。
  turndown.addRule('knowledgeImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLElement;
      const key = visualImages?.get(image.getAttribute('src') ?? '');
      return `${key ? `KNOWLEDGEVISUAL${key}TOKEN` : ''}${imagePlaceholder(image.getAttribute('alt'))}`;
    },
  });
  // Mammoth 的表格通常没有 th，不能只转换带表头的 HTML 表格。
  turndown.addRule('knowledgeTable', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from(node.querySelectorAll('tr'))
        .filter((row) => row.closest('table') === node);
      const cells = rows.map((row) => Array.from(row.children)
        .filter((cell) => cell.nodeName === 'TD' || cell.nodeName === 'TH')
        .flatMap((cell) => {
          const text = turndown.turndown(cell.innerHTML).trim()
            .replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>');
          const span = Math.min(100, Math.max(1, Number(cell.getAttribute('colspan')) || 1));
          return [text, ...Array.from({ length: span - 1 }, () => '')];
        }));
      const width = cells.reduce((max, row) => Math.max(max, row.length), 0);
      if (!width) return '';
      const formatRow = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
      const hasHeader = Boolean(rows[0]?.querySelector('th'));
      const header = hasHeader ? cells.shift()! : Array.from({ length: width }, () => '');
      const caption = node.querySelector('caption');
      return `\n\n${caption ? `${turndown.turndown(caption.innerHTML)}\n\n` : ''}${[
        formatRow(header),
        formatRow(Array.from({ length: width }, () => '---')),
        ...cells.map(formatRow),
      ].join('\n')}\n\n`;
    },
  });
  return turndown.turndown(html);
}

function htmlTitle(html: string) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || undefined;
}

function normalizePdfPageText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parsePdf(bytes: Uint8Array, captureVisuals = false) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // pdf.js 会转移底层 buffer，传副本避免影响调用方。
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  let text: string[];
  try {
    if (pdf.numPages > KNOWLEDGE_PDF_MAX_PAGES) {
      throw new Error(`PDF 页数超过 ${KNOWLEDGE_PDF_MAX_PAGES} 页上限（${pdf.numPages} 页）`);
    }
    ({ text } = await extractText(pdf, { mergePages: false }));
  } finally {
    // extractText 不销毁调用方传入的 proxy，包括解析失败的路径。
    await pdf.loadingTask.destroy();
  }
  let pages = text.map(normalizePdfPageText);
  const warnings: string[] = [];
  let ocrUsed = false;
  if (!pages.some((page) => page.trim())) {
    try {
      pages = (await ocrPdfPages(bytes, pages.length)).map(normalizePdfPageText);
      ocrUsed = true;
    } catch (error) {
      if (!captureVisuals) throw error;
      // Visual indexing can still describe image-only pages when OCR is unavailable.
      warnings.push(error instanceof Error ? error.message : 'PDF OCR 失败');
    }
  }
  const pageOffsets: number[] = [];
  let content = '';
  // 空页不拼接分隔符，保证 content 不含 \n{3,} 且首尾无空白，
  // 这样 chunkText 的 trim/折叠不会让 chunk 偏移与 pageOffsets 错位。
  for (const page of pages) {
    if (!page) {
      pageOffsets.push(content.length);
      continue;
    }
    if (content) content += '\n\n';
    pageOffsets.push(content.length);
    content += page;
  }
  return { content, pageOffsets, ocrUsed, ...(warnings.length ? { warnings } : {}) };
}

async function parseDocx(bytes: Uint8Array, captureVisuals = false) {
  // 在 Mammoth/JSZip 分配完整解压缓冲区前检查，并流式验证实际解压量。
  await validateDocxArchive(bytes);
  const mammoth = await import('mammoth');
  const visuals: ParsedVisual[] = [];
  const warnings: string[] = [];
  const markers = new Map<string, string>();
  // 默认的 images.dataUri 会把图片 base64 写进 HTML；这里不读取图片字节，只保留 alt。
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async (image) => {
      if (!captureVisuals) return { src: '' };
      if (visuals.length >= MAX_VISUAL_ASSETS) throw new Error('Too many document images');
      const key = String(visuals.length + 1);
      const src = `knowledge-visual-${key}`;
      markers.set(src, key);
      const visual: ParsedVisual = { occurrenceKey: `image-${key}`, kind: 'embedded_image' };
      visuals.push(visual);
      try {
        const data = await image.read();
        const bytes = new Uint8Array(data);
        if (bytes.length > MAX_VISUAL_BYTES) throw new Error('Image exceeds byte budget');
        visual.mimeType = validateVisualImage(bytes, image.contentType);
        visual.bytes = bytes;
      } catch {
        warnings.push(`Image ${key} could not be imported (format or resource limit)`);
      }
      return { src };
    }) },
  );
  return { content: await htmlToMarkdown(value, markers), visuals, warnings };
}

export async function parseKnowledgeFile(input: {
  fileName: string;
  kind: KnowledgeFileKind;
  bytes: Uint8Array;
  captureVisuals?: boolean;
}): Promise<ParsedKnowledgeFile> {
  const fallbackTitle = stripExtension(input.fileName);
  let parsed: ParsedKnowledgeFile;

  switch (input.kind) {
    case 'image': {
      const mime = knowledgeImageMime(input.fileName, input.bytes);
      const image = await normalizeKnowledgeImage(input.bytes, mime);
      const warnings: string[] = [];
      let content = '';
      try { content = await ocrKnowledgeImage(image); }
      catch (error) {
        if (!input.captureVisuals) throw error;
        warnings.push(error instanceof Error ? error.message : '图片 OCR 失败');
      }
      if (!content && !input.captureVisuals) {
        throw new Error('图片未识别到文字；如需检索照片、图表或流程图，请启用视觉索引');
      }
      parsed = { title: fallbackTitle, content, ocrUsed: Boolean(content), warnings,
        ...(input.captureVisuals ? { visuals: [{ occurrenceKey: 'image-1', kind: 'embedded_image',
          bytes: image, mimeType: 'image/jpeg', alt: fallbackTitle, textStart: 0, textEnd: content.length }] } : {}) };
      break;
    }
    case 'markdown': {
      const content = decodeUtf8(input.bytes);
      parsed = { title: inferMarkdownTitle(content) ?? fallbackTitle, content };
      break;
    }
    case 'text':
      parsed = { title: fallbackTitle, content: decodeUtf8(input.bytes) };
      break;
    case 'html': {
      const html = decodeUtf8(input.bytes);
      const content = await htmlToMarkdown(html);
      parsed = {
        title: htmlTitle(html) ?? inferMarkdownTitle(content) ?? fallbackTitle,
        content,
      };
      break;
    }
    case 'pdf': {
      const { content, pageOffsets, ocrUsed, warnings } = await parsePdf(input.bytes, input.captureVisuals);
      parsed = { title: fallbackTitle, content, pageOffsets, ocrUsed, warnings };
      if (input.captureVisuals) {
        parsed.visuals = pageOffsets.map((start, i) => ({
          occurrenceKey: `page-${i + 1}`, kind: 'pdf_page', pageNumber: i + 1,
          textStart: start, textEnd: pageOffsets[i + 1] ?? content.length,
        }));
      }
      break;
    }
    case 'docx': {
      const result = await parseDocx(input.bytes, input.captureVisuals);
      parsed = { title: inferMarkdownTitle(result.content) ?? fallbackTitle, ...result };
      break;
    }
  }

  if (input.kind !== 'text' && input.kind !== 'pdf' && input.kind !== 'image') {
    // 清理后的内容是 chunkText 预处理的不动点，links 偏移与 chunk 区间一致。
    const { content, links } = cleanKnowledgeMarkdown(parsed.content);
    parsed = { ...parsed, content, ...(links.length ? { links } : {}) };
  }

  if (input.captureVisuals && input.kind === 'docx') {
    // Resolve offsets only after Markdown cleanup/normalization. Strip internal markers.
    const pattern = /KNOWLEDGEVISUAL(\d+)TOKEN/g;
    const positions: { visual: ParsedVisual; offset: number }[] = [];
    let removed = 0;
    for (const match of Array.from(parsed.content.matchAll(pattern))) {
      const visual = parsed.visuals?.[Number(match[1]) - 1];
      if (visual) positions.push({ visual, offset: match.index! - removed });
      removed += match[0].length;
    }
    const original = parsed.content;
    parsed.content = original.replace(pattern, '');
    for (const { visual, offset } of positions) {
      visual.textStart = offset;
      const placeholder = /^【图片(?:：([^】]*))?】/.exec(parsed.content.slice(offset));
      visual.textEnd = offset + (placeholder?.[0].length ?? 0);
      visual.alt = placeholder?.[1];
    }
    for (const link of parsed.links ?? []) {
      const prefix = original.slice(0, link.offset);
      link.offset -= Array.from(prefix.matchAll(pattern)).reduce((n, m) => n + m[0].length, 0);
    }
  }

  if (!parsed.content.trim() && !parsed.visuals?.length) {
    throw new Error(
      input.kind === 'pdf'
        ? 'PDF 中没有可提取的文本，OCR 也未识别到文字（可能为空白扫描件或图片不清晰）'
        : '文件中没有可索引的文本内容',
    );
  }
  if (parsed.content.length > KNOWLEDGE_FILE_MAX_CHARS) {
    throw new Error(`文件文本过长（${parsed.content.length} 字符），上限 ${KNOWLEDGE_FILE_MAX_CHARS}`);
  }
  return parsed;
}

/**
 * 根据 chunk 的字符区间换算 PDF 页码（1-based）。
 */
export function pageRangeForSpan(
  pageOffsets: number[] | undefined,
  startChar: number,
  endChar: number,
): { pageStart: number; pageEnd: number } | undefined {
  if (!pageOffsets?.length) return undefined;
  const pageAt = (offset: number) => {
    let page = 0;
    for (let index = 0; index < pageOffsets.length; index++) {
      if (pageOffsets[index] <= offset) page = index;
      else break;
    }
    return page + 1;
  };
  return {
    pageStart: pageAt(startChar),
    pageEnd: pageAt(Math.max(startChar, endChar - 1)),
  };
}
