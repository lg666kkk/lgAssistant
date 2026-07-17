/**
 * 文本切块模块
 *
 * 设计目标：
 * 1. 标题、段落、代码围栏和 Markdown 表格优先保持完整。
 * 2. 字符和 token 双上限，避免中文或代码在字符数正常时 token 超限。
 * 3. 超长结构按句子/换行边界递归切分，并保留 headingPath。
 */

import { countTokens, decode, encode } from 'gpt-tokenizer';

export const CHUNKER_VERSION = 'structure-token-v2';
export const DEFAULT_CHUNK_MAX_TOKENS = 450;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 50;

export type ChunkKind = 'text' | 'code' | 'table';

/**
 * 文本块
 */
export interface TextChunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
  headingPath: string[];
  tokenCount?: number;
  kind?: ChunkKind;
}

/**
 * 切块配置
 */
export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
  minChunkSize?: number;
  maxTokens?: number;
  overlapTokens?: number;
  minTokens?: number;
}

type NormalizedChunkOptions = Required<ChunkOptions>;

type StructuredBlock = {
  text: string;
  startChar: number;
  endChar: number;
  headingPath: string[];
  kind: ChunkKind | 'heading';
};

type SourceLine = {
  raw: string;
  text: string;
  startChar: number;
  endChar: number;
};

/**
 * 将文本切分成多个块
 */
export function chunkText(
  text: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const normalizedOptions: NormalizedChunkOptions = {
    chunkSize: options.chunkSize ?? 700,
    overlap: options.overlap ?? 50,
    minChunkSize: options.minChunkSize ?? 100,
    maxTokens: options.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS,
    overlapTokens: options.overlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS,
    minTokens: options.minTokens ?? 24,
  };
  const cleanText = text.trim().replace(/\n{3,}/g, '\n\n');

  if (cleanText.length === 0) {
    return [];
  }

  if (fitsBudget(cleanText, normalizedOptions)) {
    return [createChunk({
      text: cleanText,
      index: 0,
      startChar: 0,
      endChar: cleanText.length,
      headingPath: inferHeadingPath(cleanText),
      kind: inferChunkKind(cleanText),
    })];
  }

  const chunks: TextChunk[] = [];
  const blocks = splitStructuredBlocks(cleanText);
  let currentText = '';
  let currentStart = 0;
  let currentEnd = 0;
  let currentHeadingPath: string[] = [];

  const pushCurrent = () => {
    const normalized = currentText.trim();
    if (shouldKeepChunk(normalized, normalizedOptions)) {
      chunks.push(createChunk({
        text: normalized,
        index: chunks.length,
        startChar: currentStart,
        endChar: currentEnd,
        headingPath: currentHeadingPath,
        kind: 'text',
      }));
    }
    currentText = '';
  };

  for (const block of blocks) {
    if (block.kind === 'code' || block.kind === 'table') {
      pushCurrent();
      if (fitsBudget(block.text, normalizedOptions)) {
        chunks.push(createChunk({
          text: block.text,
          index: chunks.length,
          startChar: block.startChar,
          endChar: block.endChar,
          headingPath: block.headingPath,
          kind: block.kind,
        }));
      } else {
        chunks.push(...chunkOversizedBlock(block, normalizedOptions, chunks.length));
      }
      continue;
    }

    if (!fitsBudget(block.text, normalizedOptions)) {
      pushCurrent();
      chunks.push(...chunkOversizedBlock(block, normalizedOptions, chunks.length));
      continue;
    }

    const separator = currentText ? '\n\n' : '';
    const nextText = `${currentText}${separator}${block.text}`;
    if (currentText && !fitsBudget(nextText, normalizedOptions)) {
      pushCurrent();
    }

    if (!currentText) {
      currentStart = block.startChar;
      currentHeadingPath = block.headingPath;
    }
    currentText = currentText ? `${currentText}\n\n${block.text}` : block.text;
    currentEnd = block.endChar;
  }

  pushCurrent();

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

function splitStructuredBlocks(text: string): StructuredBlock[] {
  const lines = readSourceLines(text);
  const blocks: StructuredBlock[] = [];
  const headings: string[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (!line.text.trim()) {
      lineIndex++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line.text.trim());
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].trim();
      blocks.push(blockFromLines([line], headings, 'heading'));
      lineIndex++;
      continue;
    }

    if (/^\s*```/.test(line.text)) {
      const codeLines = [line];
      lineIndex++;
      while (lineIndex < lines.length) {
        const codeLine = lines[lineIndex];
        codeLines.push(codeLine);
        lineIndex++;
        if (/^\s*```\s*$/.test(codeLine.text)) break;
      }
      blocks.push(blockFromLines(codeLines, headings, 'code'));
      continue;
    }

    if (isTableStart(lines, lineIndex)) {
      const tableLines = [line, lines[lineIndex + 1]];
      lineIndex += 2;
      while (lineIndex < lines.length && looksLikeTableRow(lines[lineIndex].text)) {
        tableLines.push(lines[lineIndex]);
        lineIndex++;
      }
      blocks.push(blockFromLines(tableLines, headings, 'table'));
      continue;
    }

    const paragraphLines = [line];
    lineIndex++;
    while (lineIndex < lines.length) {
      const nextLine = lines[lineIndex];
      if (
        !nextLine.text.trim()
        || /^(#{1,6})\s+/.test(nextLine.text.trim())
        || /^\s*```/.test(nextLine.text)
        || isTableStart(lines, lineIndex)
      ) {
        break;
      }
      paragraphLines.push(nextLine);
      lineIndex++;
    }
    blocks.push(blockFromLines(paragraphLines, headings, 'text'));
  }

  return blocks;
}

function readSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /.*(?:\n|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) break;
    const raw = match[0];
    const lineText = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    lines.push({
      raw,
      text: lineText,
      startChar: match.index,
      endChar: match.index + raw.length,
    });
  }
  return lines;
}

function blockFromLines(
  lines: SourceLine[],
  headings: string[],
  kind: StructuredBlock['kind'],
): StructuredBlock {
  const text = lines.map((line) => line.raw).join('').trim();
  return {
    text,
    startChar: lines[0].startChar,
    endChar: lines[lines.length - 1].endChar,
    headingPath: headings.filter(Boolean),
    kind,
  };
}

function isTableStart(lines: SourceLine[], index: number) {
  return Boolean(
    lines[index + 1]
    && looksLikeTableRow(lines[index].text)
    && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(
      lines[index + 1].text,
    ),
  );
}

function looksLikeTableRow(line: string) {
  return line.includes('|') && line.trim().length > 2;
}

function chunkOversizedBlock(
  block: StructuredBlock,
  options: NormalizedChunkOptions,
  startIndex: number,
) {
  const chunks: TextChunk[] = [];
  let localStart = 0;

  while (localStart < block.text.length) {
    let localEnd = findTokenLimitedEnd(
      block.text,
      localStart,
      options.maxTokens,
      options.chunkSize,
    );
    if (localEnd < block.text.length) {
      localEnd = findBestSplitPoint(block.text, localStart, localEnd);
    }
    if (localEnd <= localStart) {
      localEnd = Math.min(block.text.length, localStart + options.chunkSize);
    }

    const chunkContent = block.text.slice(localStart, localEnd).trim();
    if (chunkContent) {
      chunks.push(createChunk({
        text: chunkContent,
        index: startIndex + chunks.length,
        startChar: block.startChar + localStart,
        endChar: block.startChar + localEnd,
        headingPath: block.headingPath,
        kind: block.kind === 'heading' ? 'text' : block.kind,
      }));
    }

    if (localEnd >= block.text.length) break;
    const overlapChars = tokenOverlapChars(
      block.text.slice(localStart, localEnd),
      options.overlapTokens,
      options.overlap,
    );
    localStart = Math.max(localStart + 1, localEnd - overlapChars);
  }

  return chunks;
}

function findTokenLimitedEnd(
  text: string,
  start: number,
  maxTokens: number,
  maxChars: number,
) {
  let low = start + 1;
  let high = Math.min(text.length, start + Math.max(maxChars, 1));
  let best = low;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(start, middle);
    if (tokenLength(candidate) <= maxTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function tokenOverlapChars(text: string, overlapTokens: number, fallbackChars: number) {
  try {
    const tokens = encode(text);
    if (tokens.length === 0) return 0;
    return decode(tokens.slice(-Math.min(overlapTokens, tokens.length))).length;
  } catch {
    return Math.min(fallbackChars, text.length);
  }
}

function fitsBudget(text: string, options: NormalizedChunkOptions) {
  return text.length <= options.chunkSize && tokenLength(text) <= options.maxTokens;
}

function shouldKeepChunk(text: string, options: NormalizedChunkOptions) {
  if (!text) return false;
  return text.length >= options.minChunkSize || tokenLength(text) >= options.minTokens;
}

function createChunk(input: Omit<TextChunk, 'tokenCount'>): TextChunk {
  return {
    ...input,
    tokenCount: tokenLength(input.text),
  };
}

function tokenLength(text: string) {
  try {
    return countTokens(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function inferChunkKind(text: string): ChunkKind {
  if (/^\s*```/.test(text)) return 'code';
  const lines = text.split('\n');
  if (lines.length >= 2 && isTableStart(
    lines.map((line) => ({ raw: line, text: line, startChar: 0, endChar: 0 })),
    0,
  )) {
    return 'table';
  }
  return 'text';
}

function inferHeadingPath(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    headings.length = level - 1;
    headings[level - 1] = match[2].trim();
  }
  return headings.filter(Boolean);
}

function findBestSplitPoint(text: string, start: number, end: number): number {
  const searchRange = Math.min(200, end - start);
  const searchStart = Math.max(start, end - searchRange);
  const sentenceEnders = [
    '\n\n',
    '\n',
    '。',
    '！',
    '？',
    '.',
    '!',
    '?',
    '；',
    ';',
  ];

  for (const ender of sentenceEnders) {
    const lastIndex = text.lastIndexOf(ender, end);
    if (lastIndex > searchStart) {
      return lastIndex + ender.length;
    }
  }

  const lastSpace = text.lastIndexOf(' ', end);
  if (lastSpace > searchStart) {
    return lastSpace + 1;
  }
  return end;
}

/**
 * 统计切块信息
 */
export function getChunkStats(chunks: TextChunk[]) {
  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      totalChars: 0,
      totalTokens: 0,
      avgChunkSize: 0,
      avgChunkTokens: 0,
      minChunkSize: 0,
      maxChunkSize: 0,
    };
  }

  const sizes = chunks.map((chunk) => chunk.text.length);
  const tokenSizes = chunks.map((chunk) => chunk.tokenCount ?? tokenLength(chunk.text));
  const totalChars = sizes.reduce((sum, size) => sum + size, 0);
  const totalTokens = tokenSizes.reduce((sum, size) => sum + size, 0);

  return {
    totalChunks: chunks.length,
    totalChars,
    totalTokens,
    avgChunkSize: Math.round(totalChars / chunks.length),
    avgChunkTokens: Math.round(totalTokens / chunks.length),
    minChunkSize: Math.min(...sizes),
    maxChunkSize: Math.max(...sizes),
  };
}
