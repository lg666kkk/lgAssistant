import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking";
import { cleanKnowledgeMarkdown, imagePlaceholder, linksInSpan, safeLinkUrl } from "./content-cleanup";
import { parseKnowledgeFile } from "./file-parsers";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

/** 最小 DOCX：一段正文 + 一张带 alt 的内嵌图片 + 一个外链。 */
async function buildDocxWithImage(imageBytes: Uint8Array) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/>
</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:r><w:t>架构说明</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline>
      <wp:docPr id="1" name="Picture 1" descr="系统架构图"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">详见 </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:t>官方文档</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`);
  zip.file("word/media/image1.png", imageBytes);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("safeLinkUrl", () => {
  it("allows http, https, and mailto", () => {
    expect(safeLinkUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeLinkUrl("<http://example.com>")).toBe("http://example.com/");
    expect(safeLinkUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it("drops unsafe schemes, relative paths, and anchors", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///etc/passwd", "./a.md", "/docs", "#section", ""]) {
      expect(safeLinkUrl(url)).toBeNull();
    }
  });
});

describe("imagePlaceholder", () => {
  it("keeps a trimmed alt and falls back to a bare placeholder", () => {
    expect(imagePlaceholder("  流程\n图 ")).toBe("【图片：流程 图】");
    expect(imagePlaceholder("")).toBe("【图片】");
    expect(imagePlaceholder(null)).toBe("【图片】");
  });
});

describe("cleanKnowledgeMarkdown", () => {
  it("replaces images and keeps link text with safe urls as metadata", () => {
    const { content, links } = cleanKnowledgeMarkdown([
      "# 标题",
      "",
      "![架构图](data:image/png;base64,AAAA) ![](https://cdn.example.com/a.png \"t\")",
      "",
      "参见 [官网](https://example.com) 和 [脚本](javascript:alert(1))，",
      "[本地](./other.md)、[锚点](#top)、[邮件](mailto:a@example.com)。",
    ].join("\n"));

    expect(content).toBe([
      "# 标题",
      "",
      "【图片：架构图】 【图片】",
      "",
      "参见 官网 和 脚本，",
      "本地、锚点、邮件。",
    ].join("\n"));
    expect(content).not.toContain("base64");
    expect(links.map(({ text, url }) => ({ text, url }))).toEqual([
      { text: "官网", url: "https://example.com/" },
      { text: "邮件", url: "mailto:a@example.com" },
    ]);
    for (const link of links) {
      expect(content.slice(link.offset, link.offset + link.text.length)).toBe(link.text);
    }
  });

  it("unwraps linked images and keeps code untouched", () => {
    const { content, links } = cleanKnowledgeMarkdown([
      "[![logo](https://x.com/l.png)](https://x.com)",
      "",
      "`[a](javascript:x)`",
      "",
      "```md",
      "![keep](data:image/png;base64,BBBB)",
      "```",
    ].join("\n"));

    expect(content).toBe([
      "【图片：logo】",
      "",
      "`[a](javascript:x)`",
      "",
      "```md",
      "![keep](data:image/png;base64,BBBB)",
      "```",
    ].join("\n"));
    expect(links.map((link) => link.url)).toEqual(["https://x.com/"]);
  });

  it("ignores escaped brackets", () => {
    expect(cleanKnowledgeMarkdown("\\[not a link\\](x)").content).toBe("\\[not a link\\](x)");
  });

  it("produces a chunkText fixed point so link offsets match chunk spans", () => {
    const { content } = cleanKnowledgeMarkdown("\n\n  a [b](https://b.com)\n\n\n\nc  \n\n");
    expect(content).toBe("a b\n\nc");
    expect(content.trim().replace(/\n{3,}/g, "\n\n")).toBe(content);
  });
});

describe("linksInSpan", () => {
  it("returns deduplicated links whose offset falls inside the span", () => {
    const links = [
      { text: "a", url: "https://a.com/", offset: 1 },
      { text: "a", url: "https://a.com/", offset: 5 },
      { text: "b", url: "https://b.com/", offset: 20 },
    ];
    expect(linksInSpan(links, 0, 10)).toEqual([{ text: "a", url: "https://a.com/" }]);
    expect(linksInSpan(links, 10, 30)).toEqual([{ text: "b", url: "https://b.com/" }]);
    expect(linksInSpan(undefined, 0, 10)).toEqual([]);
  });
});

describe("file parsing cleanup", () => {
  it("replaces html data images and strips unsafe links", async () => {
    const parsed = await parseKnowledgeFile({
      fileName: "page.html",
      kind: "html",
      bytes: bytes(`<p>图：<img alt="趋势" src="data:image/png;base64,${"A".repeat(5000)}"></p>
<p><a href="javascript:alert(1)">点我</a> <a href="https://example.com/x">外链</a> <a href="#s">锚点</a></p>`),
    });
    expect(parsed.content).toBe("图：【图片：趋势】\n\n点我 外链 锚点");
    expect(parsed.links?.map(({ text, url }) => ({ text, url }))).toEqual([
      { text: "外链", url: "https://example.com/x" },
    ]);
  });

  it("cleans markdown uploads but leaves plain text alone", async () => {
    const markdown = await parseKnowledgeFile({
      fileName: "a.md",
      kind: "markdown",
      bytes: bytes("# T\n\n![x](data:image/png;base64,AAAA) [y](https://y.com)"),
    });
    expect(markdown.content).toBe("# T\n\n【图片：x】 y");

    const text = await parseKnowledgeFile({
      fileName: "a.txt",
      kind: "text",
      bytes: bytes("[y](https://y.com)"),
    });
    expect(text.content).toBe("[y](https://y.com)");
    expect(text.links).toBeUndefined();
  });

  it("keeps DOCX image alt text without embedding base64", async () => {
    const image = new Uint8Array(4096).fill(7);
    const parsed = await parseKnowledgeFile({
      fileName: "arch.docx",
      kind: "docx",
      bytes: await buildDocxWithImage(image),
    });
    expect(parsed.content).toBe("架构说明\n\n【图片：系统架构图】\n\n详见 官方文档");
    expect(parsed.content).not.toContain("base64");
    expect(parsed.links?.map(({ text, url }) => ({ text, url }))).toEqual([
      { text: "官方文档", url: "https://example.com/docs" },
    ]);

    const [chunk] = chunkText(parsed.content);
    expect(linksInSpan(parsed.links, chunk.startChar, chunk.endChar)).toEqual([
      { text: "官方文档", url: "https://example.com/docs" },
    ]);
  });
  it('captures DOCX image bytes and final normalized positions without leaking markers', async () => {
    const image = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
    image.writeUInt32BE(100, 16); image.writeUInt32BE(100, 20);
    const parsed = await parseKnowledgeFile({ fileName: 'arch.docx', kind: 'docx',
      bytes: await buildDocxWithImage(image), captureVisuals: true });
    expect(parsed.content).not.toContain('KNOWLEDGEVISUAL');
    expect(parsed.content).not.toContain('base64');
    expect(parsed.visuals).toHaveLength(1);
    const visual = parsed.visuals![0];
    expect(visual.bytes).toEqual(new Uint8Array(image));
    expect(visual.alt).toBe('系统架构图');
    expect(parsed.content.slice(visual.textStart, visual.textEnd)).toBe('【图片：系统架构图】');
    expect(parsed.content.slice(parsed.links![0].offset)).toContain('官方文档');
  });
});
