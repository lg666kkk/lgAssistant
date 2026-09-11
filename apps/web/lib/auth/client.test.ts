import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getSession: vi.fn(), signOut: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createBrowserClient: () => ({ auth }) }));
import { authFetch, LOGIN_REQUIRED_EVENT } from "./client";

describe("authFetch login dialog", () => {
  const loginRequested = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon");
    const window = new EventTarget();
    window.addEventListener(LOGIN_REQUIRED_EVENT, loginRequested);
    vi.stubGlobal("window", window);
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
    auth.signOut.mockResolvedValue({ error: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("preserves the authenticated request and returns its response", async () => {
    const response = new Response("ok");
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    expect(await authFetch("/api/example")).toBe(response);
    expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer test-token");
    expect(loginRequested).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([false, true])("opens login in place on 401, even if sign-out rejects: %s", async (reject) => {
    const response = new Response(null, { status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    if (reject) auth.signOut.mockRejectedValue(new Error("offline"));
    expect(await authFetch("/api/example")).toBe(response);
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(loginRequested).toHaveBeenCalledOnce();
  });

  it("does not log out a user who lacks permission for an operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    expect((await authFetch("/api/example")).status).toBe(403);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(loginRequested).not.toHaveBeenCalled();
  });
});
