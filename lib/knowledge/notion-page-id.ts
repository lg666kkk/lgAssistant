export function extractNotionPageId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const compact = trimmed.match(/[0-9a-fA-F]{32}/);
  if (compact) return compact[0].toLowerCase();

  const uuid = trimmed.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  return uuid ? uuid[0].replace(/-/g, "").toLowerCase() : null;
}
