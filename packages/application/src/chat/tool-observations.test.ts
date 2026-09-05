import { describe, expect, it, vi } from "vitest";
import { createTrace, type ToolTraceStep } from "@/lib/agent/runtime/trace";
import { createToolObservationProjector } from "./tool-observations";
import type { ExternalTracePort } from "./ports";

function toolStep(overrides: Partial<ToolTraceStep> = {}): ToolTraceStep {
  return {
    type: "tool", index: 1, startedAt: 1000, durationMs: 125,
    name: "view_skill", toolCallId: "call-1", input: { skillId: "text-stats" },
    ok: true, contentSummary: JSON.stringify({ name: "text-stats", skillMd: "Count words." }),
    contentTruncated: false, contentOriginalChars: 55, costPerUse: 0,
    ...overrides,
  };
}

function setup(steps = [toolStep()]) {
  const end = vi.fn();
  const external = {
    update: vi.fn(), setTraceIO: vi.fn(),
    startObservation: vi.fn<ExternalTracePort["startObservation"]>(() => ({ update: vi.fn(), end })),
  };
  const trace = createTrace("request-1", "session-1");
  trace.steps = steps;
  return { external, trace, end, project: createToolObservationProjector(external, trace.requestId) };
}

describe("tool observations", () => {
  it("projects discovery, loading, sandbox execution and ordinary tools", () => {
    const { project, trace, external, end } = setup([
      toolStep({ name: "list_skills", index: 0, input: {} }),
      toolStep(),
      toolStep({ name: "run_skill", index: 2, input: { skillId: "text-stats", skillVersion: "1.0.0" } }),
      toolStep({ name: "calculator", index: 3 }),
    ]);
    project(trace);
    expect(external.startObservation.mock.calls.map(([name]) => name)).toEqual([
      "tool:list_skills", "tool:view_skill", "tool:run_skill", "tool:calculator",
    ]);
    expect(external.startObservation).toHaveBeenNthCalledWith(2, "tool:view_skill", expect.objectContaining({
      metadata: expect.objectContaining({ skillId: "text-stats", measuredDurationMs: 125, requestId: "request-1", toolCallId: "call-1" }),
      output: expect.objectContaining({ ok: true, status: "succeeded" }),
    }), { asType: "tool" });
    expect(external.startObservation).toHaveBeenNthCalledWith(3, "tool:run_skill", expect.objectContaining({
      metadata: expect.objectContaining({ skillVersion: "1.0.0" }),
    }), { asType: "tool" });
    expect(end).toHaveBeenCalledTimes(4);
  });

  it("does not duplicate observations during repeated completion/error projections", () => {
    const { project, trace, external } = setup();
    project(trace);
    project(trace);
    trace.steps.push(toolStep({ index: 2, toolCallId: "call-2" }));
    project(trace);
    expect(external.startObservation).toHaveBeenCalledTimes(2);
  });

  it("reports failures and skipped calls without treating skipped success as execution", () => {
    const { project, trace, external } = setup([
      toolStep({ ok: false, error: "Skill unavailable" }),
      toolStep({ index: 2, metadata: { status: "duplicate_skipped" }, ok: false }),
      toolStep({ index: 3, metadata: { status: "retrieval_budget_skipped" }, ok: true }),
    ]);
    project(trace);
    expect(external.startObservation).toHaveBeenNthCalledWith(1, "tool:view_skill", expect.objectContaining({
      level: "ERROR", output: expect.objectContaining({ error: "Skill unavailable", status: "failed" }),
    }), { asType: "tool" });
    expect(external.startObservation).toHaveBeenNthCalledWith(2, "tool:view_skill", expect.objectContaining({
      level: "WARNING", output: expect.objectContaining({ status: "duplicate_skipped" }),
    }), { asType: "tool" });
    expect(external.startObservation).toHaveBeenNthCalledWith(3, "tool:view_skill", expect.objectContaining({
      output: expect.objectContaining({ status: "retrieval_budget_skipped" }),
    }), { asType: "tool" });
  });

  it("bounds payloads and redacts secrets and support files without changing local trace", () => {
    const step = toolStep({
      input: { skillId: "text-stats", password: "private-password", input: { apiKey: "private-api-key" } },
      contentSummary: JSON.stringify({
        skillMd: "user@example.com\napi_key=private-inline-secret\n" + "x".repeat(3000),
        supportFiles: { "scripts/run.mjs": "private-script-content" },
        token: "private-token", bundleBase64: "private-bundle",
      }),
      error: "secret=private-error-secret",
    });
    const original = JSON.stringify(step);
    const { project, trace, external } = setup([step]);
    project(trace);
    const payload = JSON.stringify(external.startObservation.mock.calls);
    for (const secret of ["private-password", "private-api-key", "private-inline-secret", "private-script-content", "private-token", "private-bundle", "private-error-secret", "user@example.com"]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain("REDACTED");
    expect(payload.length).toBeLessThan(2400);
    expect(JSON.stringify(step)).toBe(original);
  });

  it("isolates exporter failures and still attempts subsequent tool observations", () => {
    const { project, trace, external } = setup([toolStep(), toolStep({ index: 2 })]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    external.startObservation.mockImplementationOnce(() => { throw new Error("export failed"); });
    try {
      expect(() => project(trace)).not.toThrow();
      expect(external.startObservation).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
});
