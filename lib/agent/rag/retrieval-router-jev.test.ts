import { beforeEach, describe, expect, it, vi } from "vitest";

const jev = vi.hoisted(() => ({ evaluate: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/jev/client", () => ({ evaluateWithJev: jev.evaluate }));
vi.mock("@/lib/jev/service", () => ({ resolveUserJevConfig: jev.resolve }));

import { buildRetrievalPlanWithJev } from "./retrieval-router";

describe("Jev retrieval routing", () => {
  beforeEach(() => {
    jev.evaluate.mockReset();
    jev.resolve.mockReset().mockResolvedValue({ baseUrl: "https://api.typesafe.ai/v1", apiKey: "test", modelId: "jev-latest" });
  });

  it("keeps the rule route when Jev gives a low-confidence web suggestion", async () => {
    jev.evaluate.mockResolvedValue({
      model: "jev-1.13.0",
      answers: { route: { choice: "web", confidence: 0.38, probabilities: { web: 0.54, no_retrieval: 0.45 } } },
    });

    const plan = await buildRetrievalPlanWithJev({
      query: "帮我分析 TypeScript 后端项目如何组织模块",
      userId: "user-1",
      webEnabled: true,
    });

    expect(plan.route).toBe("no_retrieval");
    expect(plan.steps).toEqual([]);
    expect(plan.routeDecision).toMatchObject({
      provider: "jev", proposedRoute: "web", accepted: false, reason: "low_confidence", confidence: 0.38,
    });
  });

  it("accepts a confident Jev web route and rebuilds its retrieval steps", async () => {
    jev.evaluate.mockResolvedValue({
      model: "jev-1.13.0",
      answers: { route: { choice: "web", confidence: 0.82, probabilities: { web: 0.92, no_retrieval: 0.08 } } },
    });

    const plan = await buildRetrievalPlanWithJev({
      query: "帮我分析 TypeScript 后端项目如何组织模块",
      userId: "user-1",
      webEnabled: true,
    });

    expect(plan.route).toBe("web");
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((step) => step.source === "web")).toBe(true);
    expect(plan.routeDecision).toMatchObject({ provider: "jev", accepted: true, proposedRoute: "web" });
  });

  it("uses the rule route when Jev times out", async () => {
    jev.evaluate.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const plan = await buildRetrievalPlanWithJev({
      query: "帮我分析 TypeScript 后端项目如何组织模块",
      userId: "user-1",
      webEnabled: true,
    });

    expect(plan.route).toBe("no_retrieval");
    expect(plan.routeDecision).toMatchObject({ provider: "rules", accepted: false, reason: "jev_timeout" });
    expect(jev.evaluate.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
