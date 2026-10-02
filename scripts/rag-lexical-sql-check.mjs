import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lexicalTerms } from '../lib/knowledge/lexical.ts';

// Optional test runtime; install outside the project and pass its dist/index.js.
const runtimeOption = process.argv.indexOf('--pglite-path');
const runtime = runtimeOption >= 0 ? pathToFileURL(path.resolve(process.argv[runtimeOption + 1])).href : '@electric-sql/pglite';
const { PGlite } = await import(runtime);
const db = new PGlite();
await db.exec(`CREATE ROLE service_role;
CREATE TABLE notion_pages(id UUID PRIMARY KEY, user_id UUID, page_id TEXT, page_title TEXT, page_url TEXT);
CREATE TABLE documents(id UUID PRIMARY KEY, notion_page_id UUID, content TEXT, metadata JSONB, embedding TEXT);`);
const sql = fs.readFileSync(new URL('../docs/schemas/migrations/20261002-rag-lexical-search.sql', import.meta.url), 'utf8');
try {
// Text embedding stub: this suite checks the lexical migration, not pgvector.
await db.exec(sql);
await db.exec(sql); // Idempotent migration.
await db.exec(`INSERT INTO notion_pages VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','page-1','定时任务设计','https://example.com/a'),
('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000022','page-2','定时任务设计','https://example.com/b');
INSERT INTO documents VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','设计定时任务需要可靠的调度。','{"page_title":"定时任务设计","last_edited_time":"2026-10-02","source_type":"notion"}', '[1]'),
('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','设计定时任务需要可靠的调度。','{"page_title":"定时任务设计"}', '[1]');`);
const result = await db.query(`SELECT * FROM match_documents_keyword('定时 时任 任务 设计', 5, '00000000-0000-0000-0000-000000000011')`);
assert.equal(result.rows.length, 1);
assert.equal(result.rows[0].page_id, 'page-1');
assert.ok(result.rows[0].keyword_rank >= .8);
for (const filters of [{ titleContains: '不存在' }, { sourceTypes: ['document'] }, { pageIds: ['missing'] }, { timeRange: { from: '2026-10-03' } }]) {
const r = await db.query(`SELECT * FROM match_documents_keyword_filtered($1, 5, '00000000-0000-0000-0000-000000000011', $2)`, ['定时', JSON.stringify(filters)]);
assert.equal(r.rows.length, 0);
}
assert.equal((await db.query(`SELECT * FROM match_documents_keyword('', 5, '00000000-0000-0000-0000-000000000011')`)).rows.length, 0);
assert.equal((await db.query(`SELECT * FROM match_documents_keyword('定时', 5, NULL)`)).rows.length, 0);
const terms = await db.query(`SELECT rag_lexical_terms('RAG text-embedding-v4 1024维 知识库') AS terms`);
assert.deepEqual(terms.rows[0].terms, Array.from(lexicalTerms('RAG text-embedding-v4 1024维 知识库')).sort());
await db.exec(`SET enable_seqscan = off;`);
const plan = await db.query(`EXPLAIN SELECT * FROM documents WHERE lexical_vector @@ $1::tsquery`, ["'定时'"]);
assert.ok(JSON.stringify(plan.rows).includes('documents_lexical_vector_idx'));
console.log('SQL checks passed: idempotency, Chinese recall, tenant isolation, all filters, empty query, token parity, GIN plan.');
} finally { await db.close(); }
