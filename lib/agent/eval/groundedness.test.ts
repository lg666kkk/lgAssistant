import { describe, expect, it } from "vitest";
import type { GroundednessReport } from "@/lib/agent/rag/types";
import { summarizeGroundednessReports } from "./groundedness";

function report(overrides: Partial<GroundednessReport>): GroundednessReport {
  return {
    status: "pass",
    evidenceRequired: false,
    evidenceCount: 1,
    claimCount: 1,
    citedClaimCount: 1,
    coveredClaimCount: 1,
    supportedClaimCount: 1,
    citationPrecision: 1,
    citationCoverage: 1,
    groundedness: 1,
    unknownCitationIds: [],
    checks: [],
    ...overrides,
  };
}

describe("groundedness eval summary", () => {
  it("aggregates citation and groundedness metrics", () => {
    expect(summarizeGroundednessReports([
      report({}),
      report({ status: "warn", citationPrecision: 0.5, citationCoverage: 0.5, groundedness: 0.5 }),
    ])).toMatchObject({
      reports: 2,
      pass: 1,
      warn: 1,
      fail: 0,
      passRate: 0.5,
      citationPrecision: 0.75,
      citationCoverage: 0.75,
      groundedness: 0.75,
    });
  });
});
