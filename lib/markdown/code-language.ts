export function detectCodeLanguage(code: string) {
  const trimmed = code.trim();

  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Continue with syntax-based detection.
    }
  }
  if (/^\s*<(?:!doctype\s+html|\/?[a-z][^>]*>)/i.test(trimmed)) return "markup";
  if (/\b(?:interface|type)\s+[A-Za-z_$][\w$]*|:\s*(?:string|number|boolean|unknown|never)\b/.test(code)) {
    return "typescript";
  }
  if (/(?:^|\n)\s*(?:def\s+[A-Za-z_]\w*\s*\([^)]*\)|class\s+[A-Za-z_]\w*(?:\([^)]*\))?)\s*:|\b(?:elif|None|True|False)\b|(?:^|\n)\s*(?:from\s+[\w.]+\s+import\s+|import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:\n|$))/.test(code)) {
    return "python";
  }
  if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(code)) {
    return "sql";
  }
  if (/^#!\/.*\b(?:ba|z|fi)?sh\b|(?:^|\n)\s*(?:npm|pnpm|yarn|git|curl|docker|export)\s+/m.test(code)) {
    return "bash";
  }
  if (/(?:^|\n)\s*(?:function\s+[A-Za-z_$]|(?:const|let|var)\s+[A-Za-z_$]|(?:import|export)\s+|class\s+[A-Za-z_$])|=>|\b(?:console|Math|Promise)\./.test(code)) {
    return "javascript";
  }
  if (/(?:^|\n)\s*(?:[#.][\w-]+|[a-z][\w-]*(?:\s+[a-z][\w-]*)?)\s*\{[^}]*:[^}]*\}/i.test(code)) {
    return "css";
  }
  if (/^(?:#{1,6}\s|>\s|[-*]\s)|\[[^\]]+\]\([^)]+\)/m.test(code)) return "markdown";
  if (/^(?:---\s*$|[\w.-]+:\s+\S+)/m.test(code)) return "yaml";

  return "text";
}
