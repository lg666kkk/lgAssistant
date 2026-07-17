import { describe, expect, it } from 'vitest';
import { chunkText } from './chunking';

describe('structure and token aware chunking', () => {
  it('keeps fenced code as a complete structured chunk when it fits the budget', () => {
    const prose = '这是用于撑开文档长度的说明文字。'.repeat(25);
    const code = '```ts\nfunction answer() {\n\n  return 42;\n}\n```';
    const chunks = chunkText(`# 示例\n\n${prose}\n\n${code}\n\n${prose}`);
    const codeChunk = chunks.find((chunk) => chunk.kind === 'code');

    expect(codeChunk?.text).toBe(code);
    expect(codeChunk?.headingPath).toEqual(['示例']);
  });

  it('keeps a Markdown table together and labels its kind', () => {
    const prose = '背景信息。'.repeat(80);
    const table = '| 名称 | 数值 |\n|---|---|\n| A | 1 |\n| B | 2 |';
    const chunks = chunkText(`# 数据\n\n${prose}\n\n${table}\n\n${prose}`);
    const tableChunk = chunks.find((chunk) => chunk.kind === 'table');

    expect(tableChunk?.text).toBe(table);
    expect(tableChunk?.headingPath).toEqual(['数据']);
  });

  it('enforces the token cap even when the character cap is large', () => {
    const chunks = chunkText('中文语义边界测试。'.repeat(300), {
      chunkSize: 10_000,
      maxTokens: 80,
      overlapTokens: 8,
      minChunkSize: 1,
      minTokens: 1,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.tokenCount ?? 0) <= 80)).toBe(true);
  });
});
