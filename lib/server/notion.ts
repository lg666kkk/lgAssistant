/**
 * Notion 客户端模块
 * 用于读取 Notion 页面内容
 */

import { Client } from '@notionhq/client';

const MAX_BLOCK_DEPTH = 8;
const NOTION_MAX_RETRIES = 3;
const NOTION_RETRY_BASE_DELAY_MS = 800;

type NotionBlockWithDepth = {
  block: any;
  depth: number;
};

function extractPageTitle(page: any): string {
  if (!page || !('properties' in page)) {
    return 'Untitled';
  }

  for (const property of Object.values(page.properties ?? {})) {
    if (
      property &&
      typeof property === 'object' &&
      'type' in property &&
      property.type === 'title' &&
      'title' in property &&
      Array.isArray(property.title)
    ) {
      const title = property.title
        .map((item: { plain_text?: string }) => item.plain_text ?? '')
        .join('')
        .trim();

      if (title) return title;
    }
  }

  return 'Untitled';
}

/**
 * Notion 页面信息
 */
export interface NotionPageInfo {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
}

export interface NotionPageTreeItem extends NotionPageInfo {
  depth: number;
}

export type NotionPageTreeOptions = {
  maxDepth?: number;
  onPageStart?: (input: {
    pageId: string;
    depth: number;
    parentPageId?: string;
    hintedTitle?: string;
  }) => void;
  onPageLoaded?: (page: NotionPageTreeItem) => void;
  onChildPageFound?: (input: {
    parentPageId: string;
    childPageId: string;
    childTitle: string;
    depth: number;
  }) => void;
  onPageFailed?: (input: {
    pageId: string;
    depth: number;
    parentPageId?: string;
    hintedTitle?: string;
    error: unknown;
  }) => void;
  onPageRetry?: (input: {
    pageId: string;
    depth: number;
    parentPageId?: string;
    hintedTitle?: string;
    error: unknown;
    attempt: number;
    maxRetries: number;
    nextDelayMs: number;
  }) => void;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Notion 客户端类
 */
export class NotionClient {
  private client: Client;

  constructor() {
    const apiKey = process.env.NOTION_API_KEY;

    if (!apiKey) {
      throw new Error('缺少环境变量 NOTION_API_KEY');
    }

    this.client = new Client({ auth: apiKey });
  }

  /**
   * 获取页面基本信息
   */
  async getPageInfo(pageId: string): Promise<NotionPageInfo> {
    const page = await this.client.pages.retrieve({ page_id: pageId });

    if (!('url' in page) || !('last_edited_time' in page)) {
      throw new Error('无法读取 Notion 页面完整信息');
    }

    const title = extractPageTitle(page);

    return {
      id: page.id,
      title,
      url: page.url,
      lastEditedTime: page.last_edited_time,
    };
  }

  /**
   * 获取页面的所有 blocks（内容块）
   */
  async getPageBlocks(
    pageId: string,
    depth = 0,
    includeChildPageContent = false,
  ): Promise<NotionBlockWithDepth[]> {
    if (depth >= MAX_BLOCK_DEPTH) {
      return [];
    }

    const blocks: NotionBlockWithDepth[] = [];
    let cursor: string | undefined = undefined;

    // 分页获取所有 blocks
    while (true) {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const block of response.results) {
        blocks.push({ block, depth });

        const shouldReadChildren =
          'has_children' in block &&
          block.has_children &&
          'id' in block &&
          (includeChildPageContent || block.type !== 'child_page');

        if (shouldReadChildren) {
          const childBlocks = await this.getPageBlocks(block.id, depth + 1, includeChildPageContent);
          blocks.push(...childBlocks);
        }
      }

      if (!response.has_more) {
        break;
      }

      cursor = response.next_cursor || undefined;
    }

    return blocks;
  }

  /**
   * 将 block 转换为纯文本
   */
  blockToText(block: any, depth = 0): string {
    if (!block.type) return '';

    const type = block.type;
    const content = block[type];
    const richText = this.extractRichText(content?.rich_text);
    const indent = '  '.repeat(Math.max(0, depth));

    // 处理不同类型的 block
    switch (type) {
      case 'paragraph':
        return richText;

      case 'heading_1':
        return richText ? `# ${richText}` : '';

      case 'heading_2':
        return richText ? `## ${richText}` : '';

      case 'heading_3':
        return richText ? `### ${richText}` : '';

      case 'bulleted_list_item':
        return richText ? `${indent}- ${richText}` : '';

      case 'numbered_list_item':
        return richText ? `${indent}1. ${richText}` : '';

      case 'to_do': {
        const checked = content?.checked ? 'x' : ' ';
        return richText ? `${indent}- [${checked}] ${richText}` : '';
      }

      case 'toggle':
        return richText ? `${indent}- ${richText}` : '';

      case 'quote':
        return richText ? `${indent}> ${richText}` : '';

      case 'callout':
        return richText;

      case 'code':
        return richText ? `\`\`\`\n${richText}\n\`\`\`` : '';

      case 'divider':
        return '\n---\n';

      case 'child_page':
        return content?.title ? `${indent}- [子页面] ${content.title}` : '';

      default:
        // 不支持的 block 类型（如图片、文件等）
        return '';
    }
  }

  /**
   * 从 rich_text 数组中提取纯文本
   */
  private extractRichText(richText: any[]): string {
    if (!richText || richText.length === 0) return '';
    return richText.map((text) => text.plain_text).join('');
  }

  /**
   * 获取页面的完整文本内容
   */
  async getPageContent(pageId: string): Promise<string> {
    const blocks = await this.getPageBlocks(pageId);
    const textParts: string[] = [];

    for (const { block, depth } of blocks) {
      const text = this.blockToText(block, depth);
      if (text.trim()) {
        textParts.push(text);
      }
    }

    return textParts.join('\n\n');
  }

  /**
   * 获取页面的完整信息（包含内容）
   */
  async getPage(pageId: string) {
    const [info, content] = await Promise.all([
      this.getPageInfo(pageId),
      this.getPageContent(pageId),
    ]);

    return {
      ...info,
      content,
    };
  }

  /**
   * 获取页面及其下级 child_page 页面树。
   */
  async getPageTree(
    pageId: string,
    options: NotionPageTreeOptions = {},
  ): Promise<NotionPageTreeItem[]> {
    const maxDepth = options.maxDepth ?? 8;
    const visited = new Set<string>();
    const pages: NotionPageTreeItem[] = [];

    const visit = async (
      currentPageId: string,
      depth: number,
      parentPageId?: string,
      hintedTitle?: string,
    ) => {
      if (depth > maxDepth || visited.has(currentPageId)) {
        return;
      }

      visited.add(currentPageId);
      options.onPageStart?.({ pageId: currentPageId, depth, parentPageId, hintedTitle });

      for (let attempt = 0; attempt <= NOTION_MAX_RETRIES; attempt++) {
        try {
          const info = await this.getPageInfo(currentPageId);
          const page = { ...info, depth };
          pages.push(page);
          options.onPageLoaded?.(page);

          const blocks = await this.getPageBlocks(currentPageId, 0, false);
          for (const { block } of blocks) {
            if (block.type === 'child_page' && 'id' in block) {
              const childTitle = block.child_page?.title ?? 'Untitled';
              options.onChildPageFound?.({
                parentPageId: currentPageId,
                childPageId: block.id,
                childTitle,
                depth: depth + 1,
              });
              await visit(block.id, depth + 1, currentPageId, childTitle);
            }
          }

          return;
        } catch (error) {
          if (attempt < NOTION_MAX_RETRIES) {
            const nextDelayMs = NOTION_RETRY_BASE_DELAY_MS * 2 ** attempt;
            options.onPageRetry?.({
              pageId: currentPageId,
              depth,
              parentPageId,
              hintedTitle,
              error,
              attempt: attempt + 1,
              maxRetries: NOTION_MAX_RETRIES,
              nextDelayMs,
            });
            await sleep(nextDelayMs);
            continue;
          }

          options.onPageFailed?.({
            pageId: currentPageId,
            depth,
            parentPageId,
            hintedTitle,
            error,
          });

          if (depth === 0) {
            throw error;
          }

          return;
        }
      }
    };

    await visit(pageId, 0);
    return pages;
  }
}
