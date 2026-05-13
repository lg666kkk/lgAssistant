/**
 * Notion 客户端模块
 * 用于读取 Notion 页面内容
 */

import { Client } from '@notionhq/client';

/**
 * Notion 页面信息
 */
export interface NotionPageInfo {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
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

    // 提取标题
    let title = 'Untitled';
    if ('properties' in page && page.properties.title) {
      const titleProp = page.properties.title;
      if (titleProp.type === 'title' && titleProp.title.length > 0) {
        title = titleProp.title[0].plain_text;
      }
    }

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
  async getPageBlocks(pageId: string): Promise<any[]> {
    const blocks: any[] = [];
    let cursor: string | undefined = undefined;

    // 分页获取所有 blocks
    while (true) {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });

      blocks.push(...response.results);

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
  blockToText(block: any): string {
    if (!block.type) return '';

    const type = block.type;
    const content = block[type];

    // 处理不同类型的 block
    switch (type) {
      case 'paragraph':
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'quote':
      case 'callout':
        return this.extractRichText(content.rich_text);

      case 'code':
        return this.extractRichText(content.rich_text);

      case 'divider':
        return '\n---\n';

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

    for (const block of blocks) {
      const text = this.blockToText(block);
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
}
