import fs from "node:fs/promises";
import path from "node:path";

export type LoadedDocument = {
  id: string;
  title: string;
  url: string;
  content: string;
  lastEditedTime: string;
  source: "markdown" | "text";
};

export async function loadMarkdownFile(filePath: string): Promise<LoadedDocument> {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const stat = await fs.stat(absolutePath);
  const title = inferMarkdownTitle(content) ?? path.basename(filePath);

  return {
    id: absolutePath,
    title,
    url: `file://${absolutePath}`,
    content,
    lastEditedTime: stat.mtime.toISOString(),
    source: "markdown",
  };
}

function inferMarkdownTitle(content: string) {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}
