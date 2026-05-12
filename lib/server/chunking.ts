/**
 * 文本切块模块
 * 用于将长文本切分成适合向量化的小块
 */

/**
 * 文本块
 */
export interface TextChunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

/**
 * 切块配置
 */
export interface ChunkOptions {
  chunkSize?: number;      // 每块的字符数（默认 500）
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
    chunkSize = 500,
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
      },
    ];
  }

  const chunks: TextChunk[] = [];
  let startChar = 0;
  let chunkIndex = 0;

  while (startChar < cleanText.length) {
    // 计算当前块的结束位置
    let endChar = Math.min(startChar + chunkSize, cleanText.length);

    // 如果不是最后一块，尝试在句子边界处切分
    if (endChar < cleanText.length) {
      endChar = findBestSplitPoint(cleanText, startChar, endChar);
    }

    // 提取文本块
    const chunkText = cleanText.substring(startChar, endChar).trim();

    // 只保留足够长的块
    if (chunkText.length >= minChunkSize) {
      chunks.push({
        text: chunkText,
        index: chunkIndex,
        startChar,
        endChar,
      });
      chunkIndex++;
    }

    // 移动到下一块的起始位置（考虑重叠）
    const nextStart = endChar - overlap;

    // 避免无限循环：确保每次都向前移动
    if (nextStart <= startChar) {
      startChar = endChar;
    } else {
      startChar = nextStart;
    }
  }

  return chunks;
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
