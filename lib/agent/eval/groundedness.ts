import type { GroundednessReport } from "@/lib/agent/rag/types";

export function summarizeGroundednessReports(reports: GroundednessReport[]) {
  const count = reports.length;
  const average = (select: (report: GroundednessReport) => number) =>
    count > 0 ? reports.reduce((sum, report) => sum + select(report), 0) / count : 0;
  return {
    reports: count,
    pass: reports.filter((report) => report.status === "pass").length,
    warn: reports.filter((report) => report.status === "warn").length,
    fail: reports.filter((report) => report.status === "fail").length,
    passRate: count > 0
      ? reports.filter((report) => report.status === "pass").length / count
      : 0,
    citationPrecision: average((report) => report.citationPrecision),
    citationCoverage: average((report) => report.citationCoverage),
    groundedness: average((report) => report.groundedness),
  };
}
