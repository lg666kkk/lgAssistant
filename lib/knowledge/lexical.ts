/** Deterministic lexical terms shared by retrieval and evidence grading.
 * Keep this tokenizer aligned with rag_lexical_terms in the SQL migration.
 */
export function lexicalTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9_./:-]+|[\u4e00-\u9fff]+/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length === 1) terms.add(token);
      for (let index = 0; index + 1 < token.length; index++) terms.add(token.slice(index, index + 2));
    } else {
      terms.add(token);
    }
  }
  return terms;
}

export function queryTerms(query: string): Set<string> {
  const normalized = query
    .replace(/(?:请问|帮我|请帮我|介绍一下|解释一下|讲解一下|讲解|什么是|是什么|有哪些|有什么|应该|如何|怎么|怎样|为什么|多少|是否|之间|区别|差异|比较|对比)/g, ' ')
    .replace(/\b(?:what|which|how|why|is|are|the|a|an|of|to|and|with|please)\b/gi, ' ');
  return lexicalTerms(normalized);
}

export function termCoverage(query: Set<string>, text: string): number {
  if (query.size === 0) return 0;
  const terms = lexicalTerms(text);
  return Array.from(query).filter((term) => terms.has(term)).length / query.size;
}
