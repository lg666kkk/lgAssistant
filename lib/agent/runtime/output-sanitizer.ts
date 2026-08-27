export function sanitizeModelText(text: string): string {
  return text
    .replace(/<(\/)?(?:\|{1,2}|｜{1,2})\s*DSML\s*(?:\|{1,2}|｜{1,2})\s*(tool[_\\]?calls)\s*>/gi, "<$1$2>")
    .replace(/<\/?(?:\|{1,2}|｜{1,2})\s*DSML\s*(?:\|{1,2}|｜{1,2})>?/gi, "")
    .replace(/<\/?\s*tool[_\\]?calls\s*>/gi, "")
    .replace(/\binvoke\s+name=(?:"[^"]*"|'[^']*')\s*>?/gi, "")
    .replace(/\bparameter\s+name=(?:"[^"]*"|'[^']*')\s+string=(?:"true"|'true')\s*>?/gi, "")
    .replace(/\b\/?(?:invoke|parameter)\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}
