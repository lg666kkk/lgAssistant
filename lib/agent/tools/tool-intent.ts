type ModelTool = {
  name: string;
  description: string;
  input_schema: unknown;
};

const CREATE_TODO_PATTERNS = [
  /(?:创建|新建|新增|添加|记录|记)(?:一个|一条|个|条)?[^，。！？!?]{0,24}(?:待办|todo|任务)/i,
  /(?:加入|添加到|放进|记到)[^，。！？!?]{0,16}(?:待办|todo)(?:列表|清单)?/i,
  /(?:待办|todo)(?:列表|清单)?[^，。！？!?]{0,16}(?:加入|添加|创建|新建|记录)/i,
];

const MEMORY_STATEMENT_PATTERNS = [
  /(?:提醒一下|请记住|记住|记一下|记得|别忘了)[^，。！？!?]{0,80}(?:我|我的|偏好|习惯|过敏|忌口|以后)/i,
  /我(?:对[^，。！？!?]{1,30}过敏|喜欢|不喜欢|习惯|偏好|常用|忌口)[^，。！？!?]{0,80}/i,
  /以后[^，。！？!?]{0,50}(?:为我|给我|推荐|回答|生成)[^，。！？!?]{0,50}(?:不要|避免|优先|使用)/i,
];

export function isExplicitCreateTodoRequest(query: string) {
  const normalized = query.trim();
  return normalized.length > 0 && CREATE_TODO_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isLongTermMemoryStatement(query: string) {
  const normalized = query.trim();
  return normalized.length > 0 && MEMORY_STATEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterToolsForUserIntent<T extends ModelTool>(tools: T[], query: string): T[] {
  if (isLongTermMemoryStatement(query)) {
    return tools.filter((tool) => tool.name !== "create_todo" && tool.name !== "ask_user");
  }
  if (isExplicitCreateTodoRequest(query)) return tools;
  return tools.filter((tool) => tool.name !== "create_todo");
}
