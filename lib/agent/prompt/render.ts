import type { PromptSegment } from "./segments";

/**
 * 把段数组拼成模型消费的 system 字符串。
 * 段间用空行分隔，保持和旧实现一致。
 */
export function renderSegments(segments: PromptSegment[]): string {
  return segments.map((s) => s.content).join("\n\n");
}
