import { describe, expect, it } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createUuid", () => {
  it("uses crypto.randomUUID when available", () => {
    const expected = "d9428888-122b-4e2f-8f6f-3f4f50f74f8f";
    expect(createUuid({ randomUUID: () => expected })).toBe(expected);
  });

  it("creates an RFC 4122 v4 UUID when randomUUID is unavailable", () => {
    const uuid = createUuid({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(uuid).toBe("abababab-abab-4bab-abab-abababababab");
    expect(uuid).toMatch(UUID_V4_PATTERN);
  });

  it("still returns a valid UUID when Web Crypto is unavailable", () => {
    expect(createUuid(null)).toMatch(UUID_V4_PATTERN);
  });
});
