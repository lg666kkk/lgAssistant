import { afterEach, describe, expect, it } from "vitest";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "./service";

const originalKey = process.env.CONFIG_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = originalKey;
});

describe("runtime config encryption", () => {
  it("round-trips a value without exposing it in the ciphertext", () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const plaintext = "secret-value";
    const ciphertext = encryptRuntimeConfigValue(plaintext);

    expect(ciphertext).not.toContain(plaintext);
    expect(decryptRuntimeConfigValue(ciphertext)).toBe(plaintext);
  });

  it("requires a 32-byte base64 master key", () => {
    process.env.CONFIG_ENCRYPTION_KEY = "too-short";
    expect(() => encryptRuntimeConfigValue("value")).toThrow("32 字节");
  });
});
