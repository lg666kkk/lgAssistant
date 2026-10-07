export const slashCommands = [
  { name: "/compact", label: "压缩上下文", description: "压缩当前会话上下文，保留原始聊天记录" },
] as const;

export function matchSlashCommands(value: string) {
  const query = value.trimStart().toLowerCase();
  if (!/^\/[^\s]*$/.test(query)) return [];
  return slashCommands.filter((command) => command.name.startsWith(query));
}

export function parseSlashCommand(value: string) {
  const match = /^\/(compact)(?:\s+([\s\S]*))?$/i.exec(value.trim());
  return match ? { name: "compact" as const, args: match[2]?.trim() ?? "" } : null;
}

export function skillSlashQuery(value: string): string | null {
  const match = /^\/([^\s]*)$/.exec(value.trimStart());
  return match ? match[1] : null;
}

export type InstalledSkill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
}

function matchScore(text: string, query: string) {
  const normalized = normalize(text);
  if (normalized === query) return 4;
  if (normalized.startsWith(query)) return 3;
  if (normalized.includes(query)) return 2;
  // Fuzzy initials may skip characters within a word, never across unrelated descriptions.
  return text.split(new RegExp("[^\\p{L}\\p{N}_-]+", "u")).some((word) => {
    const token = normalize(word);
    let position = 0;
    let start = -1;
    for (const char of query) {
      position = token.indexOf(char, position);
      if (position < 0) return false;
      if (start < 0) start = position;
      position += char.length;
    }
    return position - start <= query.length * 2;
  }) ? 1 : 0;
}

export function searchInstalledSkills(items: InstalledSkill[], query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(normalize);
  return items.map((item, index) => {
    const fields = [item.name, item.id, item.description];
    const scores = terms.map((term) => Math.max(...fields.map((field) => matchScore(field, term))));
    return { item, index, score: scores.some((score) => !score) ? -1 : scores.reduce((sum, score) => sum + score, 0) };
  }).filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

export function skillReference(item: InstalledSkill) {
  return `本次任务请使用我选择的已安装 Skill「${item.name}」（ID: ${item.id}）。先读取该 Skill 的说明，再按照其流程完成任务；如果该 Skill 不可用，请说明原因。\n\n任务：`;
}
