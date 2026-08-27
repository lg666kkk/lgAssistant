import { describe, expect, it } from "vitest";
import type { UserLangfuseConfigView } from "./config";

describe("user Langfuse config contract", () => {
  it("does not expose plaintext keys in the browser view", () => {
    const view: UserLangfuseConfigView = {
      enabled: true,
      baseUrl: "https://cloud.langfuse.com",
      publicKeyConfigured: true,
      publicKeyHint: "pk-lf-...test",
      secretKeyConfigured: true,
      secretKeyHint: "sk-lf-...test",
    };

    expect(view).not.toHaveProperty("publicKey");
    expect(view).not.toHaveProperty("secretKey");
  });
});
