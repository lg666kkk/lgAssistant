import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ route: vi.fn(), score: vi.fn(), flush: vi.fn() }));
vi.mock("@/lib/agent/rag/retrieval-router", () => ({ buildRetrievalPlan: mocks.route }));
vi.mock("@/lib/langfuse/config", () => ({
  resolveUserLangfuseConfig: async () => ({ publicKey: "test", secretKey: "test", baseUrl: "https://example.com" }),
}));
vi.mock("langfuse", () => ({
  Langfuse: class {
    async getDataset() {
      return { items: [{ id: "case-1", input: { kind: "routing", caseId: "routing-1", query: "test" }, expectedOutput: { expectedRoute: "web" }, link: async () => {} }] };
    }
    trace() { return { update: vi.fn(), score: mocks.score }; }
    flushAsync = mocks.flush;
  },
}));

const originalArgv = process.argv;
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); });

describe("Langfuse evaluation CLI gate", () => {
  it.each(["incorrect", "exception"])("exits nonzero for %s after flushing scores", async (failure) => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ["node", "langfuse-eval.ts", "--run", "--kind", "routing", "--user-id", "test-user"];
    mocks.route.mockImplementation(() => {
      if (failure === "exception") throw new Error("evaluation failed");
      return { route: "knowledge", reason: "test" };
    });
    mocks.flush.mockResolvedValue(undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../../scripts/langfuse-eval");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.score).toHaveBeenCalledWith(expect.objectContaining({ value: 0 }));
  });
});
