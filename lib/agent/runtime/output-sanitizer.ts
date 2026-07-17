export function sanitizeModelText(text: string): string {
  return text
    .replace(/<\/?\|?\s*DSML\s*\|?>/gi, "")
    .replace(/<\/?\s*tool_calls\s*>/gi, "")
    .replace(/\binvoke\s+name=(?:"[^"]*"|'[^']*')\s*>?/gi, "")
    .replace(/\bparameter\s+name=(?:"[^"]*"|'[^']*')\s+string=(?:"true"|'true')\s*>?/gi, "")
    .replace(/\b\/?(?:invoke|parameter)\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}
