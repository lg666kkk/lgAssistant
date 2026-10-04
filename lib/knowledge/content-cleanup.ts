/**
 * 入库前清理 Markdown 中的图片与链接：
 * - 图片替换为占位符，只保留 alt，base64 / 图片 URL 不进入切块和 Embedding；
 * - 链接正文只留文字，安全的 URL 单独返回，供 chunk metadata 引用。
 */

export const KNOWLEDGE_IMAGE_PLACEHOLDER = '图片';
const MAX_ALT_CHARS = 200;
const MAX_LINK_TEXT_CHARS = 200;
const MAX_LINK_URL_CHARS = 2048;
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type KnowledgeLink = {
  text: string;
  url: string;
  /** 链接文字在清理后 content 中的起始偏移。 */
  offset: number;
};

export type CleanedKnowledgeMarkdown = {
  content: string;
  links: KnowledgeLink[];
};

// 用全角括号，避免占位符后紧跟 "(" 时被当成 Markdown 链接再次解析。
export function imagePlaceholder(alt?: string | null) {
  const text = (alt ?? '')
    .replace(/[【】]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ALT_CHARS);
  return text ? `【${KNOWLEDGE_IMAGE_PLACEHOLDER}：${text}】` : `【${KNOWLEDGE_IMAGE_PLACEHOLDER}】`;
}

export function safeLinkUrl(raw: string): string | null {
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value || value.length > MAX_LINK_URL_CHARS) return null;
  try {
    // 没有 base URL 时相对链接和 #锚点会解析失败，直接丢弃。
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// ![alt](src "title")，src 允许一层括号；alt 允许一层方括号。
const IMAGE_PATTERN = /(?<!\\)!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(?:<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
// [text](href "title")，text 允许一层方括号；跳过 Turndown 转义的 \\[ \\]。
const LINK_PATTERN = /(?<!\\)\[((?:[^[\]]|\[[^[\]]*\])*)(?<!\\)\]\(\s*(<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const FENCE_PATTERN = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\S\n]*$/gm;
const INLINE_CODE_PATTERN = /(`+)[\s\S]*?[^`]\1(?!`)/g;

/** 对代码块/行内代码之外的文本应用 transform，代码保持原样。 */
function mapOutsideCode(markdown: string, transform: (text: string) => string) {
  const mapInline = (text: string) => mapOutside(text, INLINE_CODE_PATTERN, transform);
  return mapOutside(markdown, FENCE_PATTERN, mapInline);
}

function mapOutside(text: string, pattern: RegExp, transform: (text: string) => string) {
  let result = '';
  let last = 0;
  for (const match of Array.from(text.matchAll(pattern))) {
    const index = match.index ?? 0;
    result += transform(text.slice(last, index)) + match[0];
    last = index + match[0].length;
  }
  return result + transform(text.slice(last));
}

/** 与 chunkText 的预处理一致，使 content 成为其不动点，偏移不会错位。 */
export function normalizeKnowledgeContent(content: string) {
  return content.trim().replace(/\n{3,}/g, '\n\n');
}

export function cleanKnowledgeMarkdown(markdown: string): CleanedKnowledgeMarkdown {
  const found: { text: string; url: string }[] = [];

  const cleaned = mapOutsideCode(markdown, (segment) => segment
    .replace(IMAGE_PATTERN, (_match, alt: string) => imagePlaceholder(alt))
    .replace(LINK_PATTERN, (_match, rawText: string, rawUrl: string) => {
      const text = rawText.replace(/\s+/g, ' ').trim();
      const url = safeLinkUrl(rawUrl);
      if (text && url) found.push({ text: text.slice(0, MAX_LINK_TEXT_CHARS), url });
      return text;
    }));
  const content = normalizeKnowledgeContent(cleaned);

  // 在最终 content 中按顺序定位链接文字，归一化后偏移依然准确。
  const links: KnowledgeLink[] = [];
  let cursor = 0;
  for (const link of found) {
    const offset = content.indexOf(link.text, cursor);
    if (offset < 0) continue;
    links.push({ ...link, offset });
    cursor = offset + link.text.length;
  }
  return { content, links };
}

/** 取 chunk 区间内的链接，去重并限制数量，写入 chunk metadata。 */
export function linksInSpan(
  links: KnowledgeLink[] | undefined,
  startChar: number,
  endChar: number,
  limit = 20,
): { text: string; url: string }[] {
  if (!links?.length) return [];
  const seen = new Set<string>();
  const result: { text: string; url: string }[] = [];
  for (const link of links) {
    if (link.offset < startChar || link.offset >= endChar) continue;
    const key = `${link.text}\n${link.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ text: link.text, url: link.url });
    if (result.length >= limit) break;
  }
  return result;
}
