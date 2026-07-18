import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  redactSensitiveValue,
  traceRetentionUntil,
} from "./governance";

describe("RAG governance helpers", () => {
  it("redacts common PII and secret formats recursively", () => {
    expect(redactSensitiveText(
      "联系 me@example.com 或 13800138000，token-abcdefghijklmnop",
    )).toBe(
      "联系 [REDACTED_EMAIL] 或 [REDACTED_PHONE]，[REDACTED_SECRET]",
    );
    expect(redactSensitiveValue({ nested: ["me@example.com"] })).toEqual({
      nested: ["[REDACTED_EMAIL]"],
    });
  });

  it("calculates an explicit trace retention deadline", () => {
    expect(traceRetentionUntil(new Date("2026-07-17T00:00:00.000Z"), 30))
      .toBe("2026-08-16T00:00:00.000Z");
  });
});
