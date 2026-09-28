import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock("@/lib/platform/supabase", () => ({ getSupabase: mocks.getSupabase }));

import { getE2BApiKey, getUserSandboxConfigView, saveUserSandboxConfig } from "./config";

function fakeDatabase() {
  const rows = new Map<string, Record<string, unknown>>();
  const from = (table: string) => {
    let action = "select";
    let payload: Record<string, unknown> = {};
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (field: string, value: unknown) => { filters.push([field, value]); return query; },
      in: () => query,
      upsert: (value: Record<string, unknown>) => { action = "upsert"; payload = value; return query; },
      insert: () => { action = "insert"; return query; },
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise.resolve(result()).then(resolve, reject),
    };
    function result() {
      if (table === "sandbox_runs") return { count: 0, error: null };
      if (table === "user_sandbox_config_audit") return { error: null };
      if (table !== "user_sandbox_configs") throw new Error(`Unexpected table: ${table}`);
      if (action === "upsert") {
        rows.set(String(payload.user_id), payload);
        return { error: null };
      }
      const userId = String(filters.find(([field]) => field === "user_id")?.[1]);
      return { data: rows.get(userId) ?? null, error: null };
    }
    return query;
  };
  return { from, rows };
}

describe("user sandbox credentials", () => {
  const encryptionKey = process.env.CONFIG_ENCRYPTION_KEY;
  const environmentKey = process.env.E2B_API_KEY;

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    delete process.env.E2B_API_KEY;
    mocks.getSupabase.mockReset().mockReturnValue(fakeDatabase());
  });

  afterEach(() => {
    if (encryptionKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = encryptionKey;
    if (environmentKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = environmentKey;
  });

  it("encrypts and isolates each signed-in user's key", async () => {
    const database = fakeDatabase();
    mocks.getSupabase.mockReturnValue(database);
    await saveUserSandboxConfig({ userId: "user-1", apiKey: "e2b-first-secret" });
    await saveUserSandboxConfig({ userId: "user-2", apiKey: "e2b-second-secret" });

    expect(await getE2BApiKey("user-1")).toBe("e2b-first-secret");
    expect(await getE2BApiKey("user-2")).toBe("e2b-second-secret");
    expect(String(database.rows.get("user-1")?.api_key_ciphertext)).not.toContain("first-secret");
    expect(await getUserSandboxConfigView("user-1")).toMatchObject({
      configured: true, hint: "••••cret", source: "user",
    });
  });

  it("uses the server environment key only when the user has no saved key", async () => {
    process.env.E2B_API_KEY = "e2b-server-fallback";
    expect(await getE2BApiKey("user-1")).toBe("e2b-server-fallback");
    expect(await getUserSandboxConfigView("user-1")).toMatchObject({ source: "environment", configured: true });
  });
});
