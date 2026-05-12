/**
 * Embedding 向量模型模块
 * 用于将文本转换为向量，支持语义检索
 */

import OpenAI from 'openai';

/**
 * Embedding 客户端类
 * 封装了向量生成的所有操作
 */
export class EmbeddingClient {
  private client: OpenAI;
  private model: string;

  constructor() {
    // 从环境变量读取配置
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseURL = process.env.DASHSCOPE_BASE_URL;

    if (!apiKey) {
      throw new Error('缺少环境变量 DASHSCOPE_API_KEY');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    });

    this.model = 'text-embedding-v4';
  }

  /**
   * 为单条文本生成向量
   * @param text 文本内容
   * @returns 1024 维向量数组
   */
  async embedSingle(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text
    });

    return response.data[0].embedding;
  }

  /**
   * 为多条文本批量生成向量
   * @param texts 文本数组
   * @returns 向量数组
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts
    });

    return response.data.map(d => d.embedding);
  }
}

/**
 * 计算两个向量的余弦相似度
 * @param a 向量 A
 * @param b 向量 B
 * @returns 相似度分数 (0-1)，越接近 1 越相似
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
