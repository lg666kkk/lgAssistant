const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const SECRET_PATTERN = /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi;

export function redactSensitiveText(text: string) {
  return text
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
    .replace(SECRET_PATTERN, "[REDACTED_SECRET]");
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      redactSensitiveValue(item),
    ]),
  ) as T;
}

export function traceRetentionUntil(now = new Date(), retentionDays = 30) {
  return new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
}
