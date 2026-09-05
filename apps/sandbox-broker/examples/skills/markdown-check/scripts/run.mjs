import { readFile, writeFile } from "node:fs/promises";

const input = JSON.parse(await readFile("input.json", "utf8"));
const lines = input.markdown.split(/\r?\n/);
const headings = lines
  .map((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    return match ? { line: index + 1, level: match[1].length, text: match[2].trim() } : null;
  })
  .filter(Boolean);

const issues = [];
for (let index = 1; index < headings.length; index += 1) {
  if (headings[index].level > headings[index - 1].level + 1) {
    issues.push({
      line: headings[index].line,
      code: "heading-level-skip",
      message: `标题层级从 H${headings[index - 1].level} 跳到了 H${headings[index].level}`,
    });
  }
}

await writeFile("result.json", JSON.stringify({ valid: issues.length === 0, headings, issues }), "utf8");
