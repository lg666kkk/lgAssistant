import type { RagEvalCase } from './rag';

/** Repository-backed, deterministic fixtures; these are not labels for a user's live Notion corpus. */
export const ragFixtureSources = {
  ingestion: { path: 'lib/knowledge/sync.ts', text: 'Notion 页面同步先计算内容 hash。内容、embedding 模型和 chunker 版本一致时跳过重新嵌入。Embedding 批次通过向量校验后，在数据库事务中原子替换 chunks，失败时整体回滚。标题或编辑时间变化时刷新页面元数据。' },
  retrieval: { path: 'lib/knowledge/retriever.ts', text: 'RAG 混合检索并行执行向量召回与关键词召回，用 RRF 融合排序。条件 Cross-Encoder 对候选进行精排，失败时回退规则重排。MMR 使用向量相似度减少重复证据，没有向量时使用文本相似度。' },
  context: { path: 'lib/agent/tools/search-notes.ts', text: '上下文保留命中的 child，再扩展 parent 周边内容。同一 parent 的多个命中片段合并并去重。上下文预算为 2400 tokens，裁剪后重新判断证据充分性。多跳检索的每个子问题都需要可见证据支持。' },
  embedding: { path: 'lib/knowledge/embedding.ts', text: 'Embedding 默认向量维度为 1024。批次响应需要校验返回数量、index 唯一性、维度、有限数与非零向量，并按 provider index 重排。瞬时错误可以重试，稳定的 Idempotency-Key 标识同一批请求。' },
  lexical: { path: 'lib/knowledge/lexical.ts', text: '中文关键词检索统一生成双字词项，英文技术名词保留完整 token。数据库为正文、标题和 heading 建立 GIN 词项索引，标题权重高于正文。查询与文档使用相同词项规则。' },
  evidence: { path: 'lib/agent/rag/evidence-grader.ts', text: '证据充分性需要正文覆盖问题词项。高相似度与双路召回不能单独证明有答案。同一 parent 的重复 chunks 不算独立证据。数字条件与引号实体需要出现在正文里。部分覆盖只能作为弱证据保守引用。' },
  routing: { path: 'lib/agent/rag/retrieval-router.ts', text: '检索路由在 knowledge、web、both 与 no_retrieval 之间选择。用户明确要求查知识库时使用 knowledge。需要公开实时信息时优先 web。联网关闭时 Web 工具不可见。知识库画像用于判断私有主题相关性。' },
} as const;

type SourceId = keyof typeof ragFixtureSources;
export type RagRegressionCase = RagEvalCase & {
  candidateSources: SourceId[];
  expectedAllSources: SourceId[];
  subqueries?: string[];
};

function positive(id: string, question: string, source: SourceId, keywords: string[], category: RagEvalCase['category'] = 'direct'): RagRegressionCase {
  return { id, question, category, candidateSources: [source, 'routing'],
    expectedAllSources: [source], expectedKeywords: keywords, expectedEvidenceSufficient: true };
}

export const ragRegressionCases: RagRegressionCase[] = [
  positive('sync-hash', 'Notion 内容 hash', 'ingestion', ['hash']),
  positive('sync-skip', 'embedding 模型 chunker 版本一致', 'ingestion', ['跳过']),
  positive('sync-atomic', '数据库事务原子替换 chunks', 'ingestion', ['原子替换']),
  positive('sync-rollback', '数据库事务失败回滚', 'ingestion', ['回滚']),
  positive('sync-metadata', '标题编辑时间元数据', 'ingestion', ['元数据']),
  positive('hybrid', '向量召回与关键词召回如何并行', 'retrieval', ['向量', '关键词']),
  positive('rrf', 'RRF 融合排序', 'retrieval', ['RRF']),
  positive('cross', 'Cross-Encoder 候选精排', 'retrieval', ['精排']),
  positive('cross-fallback', '精排失败规则重排', 'retrieval', ['规则重排']),
  positive('mmr', 'MMR 减少重复证据', 'retrieval', ['MMR']),
  positive('parent', 'child parent 上下文', 'context', ['child', 'parent']),
  positive('parent-dedup', '同一 parent 命中片段去重', 'context', ['去重']),
  positive('context-budget', '上下文预算 2400 tokens', 'context', ['2400']),
  positive('context-regrade', '裁剪后证据充分性', 'context', ['重新判断']),
  positive('vector-dim', 'Embedding 向量维度 1024', 'embedding', ['1024']),
  positive('vector-index', 'provider index 重排', 'embedding', ['重排']),
  positive('vector-validation', '有限数非零向量校验', 'embedding', ['非零']),
  positive('idempotency', 'Idempotency-Key 同一批请求', 'embedding', ['Idempotency-Key']),
  positive('chinese', '中文关键词检索词项', 'lexical', ['双字'], 'semantic'),
  positive('english', '英文技术名词 token', 'lexical', ['token'], 'keyword'),
  positive('gin', 'GIN 词项索引', 'lexical', ['GIN'], 'keyword'),
  positive('title-weight', '标题权重正文', 'lexical', ['标题权重'], 'semantic'),
  positive('confidence', '高相似度双路召回', 'evidence', ['不能单独'], 'confusing'),
  positive('independent', '重复 chunks 独立证据', 'evidence', ['不算独立'], 'confusing'),
  positive('condition', '数字条件引号实体正文', 'evidence', ['正文'], 'confusing'),
  positive('weak', '部分覆盖弱证据引用', 'evidence', ['弱证据'], 'semantic'),
  { id: 'multi-sync-search', question: '原子替换 chunks 和 RRF 融合排序', category: 'multi-hop', candidateSources: ['ingestion', 'retrieval'], expectedAllSources: ['ingestion', 'retrieval'], expectedKeywords: ['原子替换', 'RRF'], subqueries: ['原子替换 chunks', 'RRF 融合排序'], expectedEvidenceSufficient: true },
  { id: 'multi-embed-context', question: '向量维度 1024 和上下文预算 2400 tokens', category: 'multi-hop', candidateSources: ['embedding', 'context'], expectedAllSources: ['embedding', 'context'], expectedKeywords: ['1024', '2400'], subqueries: ['向量维度 1024', '上下文预算 2400 tokens'], expectedEvidenceSufficient: true },
  { id: 'multi-missing-hop', question: 'RRF 融合排序和火星基地预算', category: 'multi-hop', candidateSources: ['retrieval'], expectedAllSources: ['retrieval'], expectedKeywords: ['RRF'], subqueries: ['RRF 融合排序', '火星基地预算'], expectedEvidenceSufficient: false },
  { id: 'multi-missing-number', question: '向量维度 1536 和上下文预算 2400 tokens', category: 'multi-hop', candidateSources: ['embedding', 'context'], expectedAllSources: ['embedding', 'context'], expectedKeywords: ['1024', '2400'], subqueries: ['向量维度 1536', '上下文预算 2400 tokens'], expectedEvidenceSufficient: false },
  ...[
    ['private-phone', '小学班主任手机号'], ['private-bank', '银行卡密码'],
    ['absent-invoice', '发票抬头税号'], ['absent-travel', '机票航班座位'],
    ['absent-medicine', '药物剂量禁忌'], ['absent-budget', '火星基地航线'],
  ].map(([id, question]): RagRegressionCase => ({ id, question, category: 'no-result',
    candidateSources: ['ingestion', 'retrieval', 'context'], expectedAllSources: [],
    expectedNoResult: true, expectedEvidenceSufficient: false })),
];
