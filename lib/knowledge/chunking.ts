/**
 * 文本切块模块
 * 用于将长文本切分成适合向量化的小块。
 *
 * 设计目标：
 * 1. 优先保留标题/段落/列表结构，而不是从任意字符处硬切。
 * 2. 每个 chunk 携带 headingPath，后续可用于引用、过滤、重排。
 * 3. 对超长段落保留字符级兜底，避免异常长文本撑爆 embedding 输入。
 */

export const CHUNKER_VERSION = 'recursive-heading-v1';

/**
 * 文本块
 */
export interface TextChunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
  headingPath: string[];
}

/**
 * 切块配置
 */
export interface ChunkOptions {
  chunkSize?: number;      // 每块的目标字符数（默认 700）
  overlap?: number;         // 重叠字符数（默认 50）
  minChunkSize?: number;    // 最小块大小（默认 100）
}

/**
 * 将文本切分成多个块
 * @param text 原始文本
 * @param options 切块配置
 * @returns 文本块数组
 */
export function chunkText(
  text: string,
  options: ChunkOptions = {}
): TextChunk[] {
  const {
    chunkSize = 700,
    overlap = 50,
    minChunkSize = 100,
  } = options;

  // 清理文本：去除多余空白
  const cleanText = text.trim().replace(/\n{3,}/g, '\n\n');

  if (cleanText.length === 0) {
    return [];
  }

  // 如果文本本身就很短，直接返回
  if (cleanText.length <= chunkSize) {
    return [
      {
        text: cleanText,
        index: 0,
        startChar: 0,
        endChar: cleanText.length,
        headingPath: inferHeadingPath(cleanText),
      },
    ];
  }

  const chunks: TextChunk[] = [];
  const blocks = splitStructuredBlocks(cleanText);
  let currentText = '';
  let currentStart = 0;
  let currentEnd = 0;
  let currentHeadingPath: string[] = [];

  const pushCurrent = () => {
    const text = currentText.trim();
    if (text.length >= minChunkSize) {
      chunks.push({
        text,
        index: chunks.length,
        startChar: currentStart,
        endChar: currentEnd,
        headingPath: currentHeadingPath,
      });
    }
    currentText = '';
  };

  for (const block of blocks) {
    if (block.text.length > chunkSize * 1.5) {
      pushCurrent();
      const fallbackChunks = chunkByCharacters(block.text, {
        chunkSize,
        overlap,
        minChunkSize,
        offset: block.startChar,
        headingPath: block.headingPath,
        startIndex: chunks.length,
      });
      chunks.push(...fallbackChunks);
      continue;
    }

    const separator = currentText ? '\n\n' : '';
    const nextText = `${currentText}${separator}${block.text}`;
    if (currentText && nextText.length > chunkSize) {
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

type StructuredBlock = {
  text: string;
  startChar: number;
  endChar: number;
  headingPath: string[];
};

function splitStructuredBlocks(text: string): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  const headings: string[] = [];
  const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0].trim();
    if (!raw) continue;

    const heading = /^(#{1,3})\s+(.+)$/.exec(raw.split('\n')[0].trim());
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].trim();
    }

    blocks.push({
      text: raw,
      startChar: match.index,
      endChar: match.index + match[0].length,
      headingPath: headings.filter(Boolean),
    });
  }

  return blocks;
}

function chunkByCharacters(
  text: string,
  options: Required<ChunkOptions> & {
    offset: number;
    headingPath: string[];
    startIndex: number;
  },
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let startChar = 0;

  while (startChar < text.length) {
    let endChar = Math.min(startChar + options.chunkSize, text.length);
    if (endChar < text.length) {
      endChar = findBestSplitPoint(text, startChar, endChar);
    }

    const chunkText = text.substring(startChar, endChar).trim();
    if (chunkText.length >= options.minChunkSize) {
      chunks.push({
        text: chunkText,
        index: options.startIndex + chunks.length,
        startChar: options.offset + startChar,
        endChar: options.offset + endChar,
        headingPath: options.headingPath,
      });
    }

    const nextStart = endChar - options.overlap;
    if (nextStart <= startChar) {
      startChar = endChar;
    } else {
      startChar = nextStart;
    }
  }

  return chunks;
}

function inferHeadingPath(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    headings.length = level - 1;
    headings[level - 1] = match[2].trim();
  }
  return headings.filter(Boolean);
}

/**
 * 寻找最佳切分点（尽量在句子边界）
 * @param text 文本
 * @param start 起始位置
 * @param end 期望的结束位置
 * @returns 实际的结束位置
 */
function findBestSplitPoint(text: string, start: number, end: number): number {
  // 在期望结束位置附近寻找句子边界
  const searchRange = 100; // 向前搜索 100 个字符
  const searchStart = Math.max(start, end - searchRange);

  // 句子结束标记（优先级从高到低）
  const sentenceEnders = [
    '\n\n',  // 段落分隔
    '。',    // 中文句号
    '！',    // 中文感叹号
    '？',    // 中文问号
    '.',     // 英文句号
    '!',     // 英文感叹号
    '?',     // 英文问号
    '\n',    // 换行
    '；',    // 中文分号
    ';',     // 英文分号
  ];

  // 从后往前查找最近的句子边界
  for (const ender of sentenceEnders) {
    const lastIndex = text.lastIndexOf(ender, end);
    if (lastIndex > searchStart) {
      // 返回标点符号之后的位置
      return lastIndex + ender.length;
    }
  }

  // 如果找不到句子边界，尝试在空格处切分
  const lastSpace = text.lastIndexOf(' ', end);
  if (lastSpace > searchStart) {
    return lastSpace + 1;
  }

  // 实在找不到合适的切分点，就在原位置切分
  return end;
}

/**
 * 统计切块信息
 * @param chunks 文本块数组
 * @returns 统计信息
 */
export function getChunkStats(chunks: TextChunk[]) {
  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      totalChars: 0,
      avgChunkSize: 0,
      minChunkSize: 0,
      maxChunkSize: 0,
    };
  }

  const sizes = chunks.map((c) => c.text.length);
  const totalChars = sizes.reduce((sum, size) => sum + size, 0);

  return {
    totalChunks: chunks.length,
    totalChars,
    avgChunkSize: Math.round(totalChars / chunks.length),
    minChunkSize: Math.min(...sizes),
    maxChunkSize: Math.max(...sizes),
  };
}
