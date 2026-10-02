import { describe, expect, it } from 'vitest';
import { lexicalTerms, queryTerms, termCoverage } from './lexical';
import { buildKeywordQuery } from './retriever';

describe('Chinese lexical retrieval', () => {
  it('matches Chinese terms across different sentence boundaries', () => {
    const query = queryTerms('定时任务应该怎么设计？');
    expect(query).toContain('定时');
    expect(query).toContain('任务');
    expect(query).not.toContain('应该');
    expect(termCoverage(query, '设计定时任务需要可靠的调度。')).toBe(1);
  });
  it('preserves technical names and numerical conditions', () => {
    expect(Array.from(lexicalTerms('RAG text-embedding-v4 1024维 中文'))).toEqual(
      ['rag', 'text-embedding-v4', '1024', '维', '中文']);
  });
  it('uses identical document/query bigrams even for three-character words', () => {
    expect(Array.from(lexicalTerms('知识库'))).toEqual(['知识', '识库']);
    expect(termCoverage(queryTerms('知识库如何检索'), '知识库检索')).toBe(1);
  });
  it('builds bounded keyword queries without treating a whole Chinese question as a term', () => {
    const terms = buildKeywordQuery(['定时任务应该怎么设计？']).split(' ');
    expect(terms).toContain('定时');
    expect(terms).not.toContain('定时任务应该怎么设计');
    expect(buildKeywordQuery(['中'.repeat(100)])).toBe('中中');
  });
});
