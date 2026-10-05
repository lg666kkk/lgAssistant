import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseKnowledgeFile } from './file-parsers';

const model = `<mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="自动召回" vertex="1" parent="1"/>
  <object id="b" label="回答前查询记忆"><mxCell vertex="1" parent="1"/></object>
  <mxCell id="edge" source="a" target="b" value="命中规则" edge="1" parent="1"/>
</root></mxGraphModel>`;

function exportHtml(xml: string) {
  const payload = JSON.stringify({ xml }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<html><head><title>记忆系统-召回</title></head><body><section><div data-mxgraph="${payload}"></div></section>
    <script src="https://example.invalid/viewer.js"></script></body></html>`;
}

function parse(xml: string) {
  return parseKnowledgeFile({ fileName: '记忆系统-召回.html', kind: 'html',
    bytes: new TextEncoder().encode(exportHtml(xml)) });
}

describe('draw.io HTML indexing', () => {
  it('extracts labels and explicit connections from an otherwise empty HTML body', async () => {
    const result = await parse(`<mxfile><diagram name="召回流程">${model}</diagram></mxfile>`);
    expect(result.title).toBe('记忆系统-召回');
    expect(result.content).toContain('## 召回流程');
    expect(result.content).toContain('源节点：自动召回；目标节点：回答前查询记忆；连线文字：命中规则');
    expect(result.content).not.toContain('viewer.js');
  });

  it('decodes compressed diagram pages and keeps pages separate', async () => {
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
    const result = await parse(`<mxfile><diagram name="自动召回">${compressed}</diagram><diagram name="主动召回">${model}</diagram></mxfile>`);
    expect(result.content).toContain('## 自动召回');
    expect(result.content).toContain('## 主动召回');
    expect(result.content).toContain('回答前查询记忆');
  });

  it('does not execute or index scripts embedded in graph labels', async () => {
    const result = await parse(`<mxfile><diagram>${model.replace('自动召回', '&lt;b&gt;自动召回&lt;/b&gt;&lt;script&gt;UNTRUSTED_SCRIPT&lt;/script&gt;')}</diagram></mxfile>`);
    expect(result.content).toContain('自动召回');
    expect(result.content).not.toContain('UNTRUSTED_SCRIPT');
  });

  it('keeps code-styled labels and their connections together as readable text', async () => {
    const result = await parse(`<mxfile><diagram>${model.replace('自动召回', '&lt;pre&gt;&lt;code&gt;自动召回&lt;br/&gt;恢复上下文&lt;/code&gt;&lt;/pre&gt;')}</diagram></mxfile>`);
    expect(result.content).toContain('源节点：自动召回 恢复上下文；目标节点：回答前查询记忆');
    expect(result.content).not.toContain('```');
  });

  it('rejects unusable diagrams instead of successfully indexing only the title', async () => {
    await expect(parse('<mxfile><diagram>broken</diagram></mxfile>')).rejects.toThrow('无法提取 draw.io');
    await expect(parse('<!DOCTYPE mxfile><mxfile/>')).rejects.toThrow('无法提取 draw.io');
  });
});
