import { createHash } from "node:crypto";
import type { SearchResult } from "@/lib/knowledge/retriever";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
  type EvidenceGrade,
  type EvidenceItem,
  type RetrievalAttempt,
  type RetrievalPlan,
  type RetrievalRoute,
} from "./types";

export type WebEvidenceResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

export function createKnowledgeEvidenceItems(results: SearchResult[]): EvidenceItem[] {
  return results.map((result) => {
    const metadata = result.metadata ?? {};
    const documentVersion = stringValue(metadata.content_hash)
      || stringValue(metadata.last_edited_time)
      || "version-unknown";
    return {
      evidenceId: evidenceId("knowledge", result.id, documentVersion),
      source: "knowledge",
      chunkId: result.id,
      documentId: result.pageId,
      documentVersion,
      title: result.pageTitle,
      content: result.parentContent ?? result.content,
      scores: {
        vector: result.vectorScore,
        keyword: result.keywordScore,
        fusion: result.rrfScore ?? result.combinedScore,
        rerank: result.rerankScore,
        crossEncoder: result.crossEncoderScore,
      },
      trustLevel: "private_user_content",
      citation: {
        url: result.pageUrl,
        headingPath: result.headingPath,
        startChar: numberValue(metadata.start_char),
        endChar: numberValue(metadata.end_char),
        quotedText: result.content.replace(/\s+/g, " ").trim().slice(0, 240),
      },
    };
  });
}

export function createWebEvidenceItems(results: WebEvidenceResult[]): EvidenceItem[] {
  return results.flatMap((result) => {
    const url = result.url?.trim();
    if (!url) return [];
    const version = new Date().toISOString().slice(0, 10);
    return [{
      evidenceId: evidenceId("web", url, version),
      source: "web" as const,
      documentId: url,
      documentVersion: version,
      title: result.title?.trim() || url,
      content: result.content?.trim() || "",
      scores: { provider: finiteScore(result.score) },
      trustLevel: trustForUrl(url),
      citation: {
        url,
        quotedText: result.content?.replace(/\s+/g, " ").trim().slice(0, 240),
      },
    }];
  });
}

export function createEvidenceBundle(input: {
  plan?: RetrievalPlan;
  route: RetrievalRoute;
  query: string;
  indexVersion: string;
  evidences: EvidenceItem[];
  grade: EvidenceGrade;
  attempts: RetrievalAttempt[];
}): EvidenceBundle {
  const bundleId = createHash("sha256")
    .update(JSON.stringify({
      planId: input.plan?.id,
      query: input.query,
      evidences: input.evidences.map((item) => item.evidenceId),
    }))
    .digest("hex")
    .slice(0, 16);
  return {
    bundleId: `evidence-${bundleId}`,
    version: AGENTIC_RAG_VERSION,
    planId: input.plan?.id,
    route: input.route,
    query: input.query,
    indexVersion: input.indexVersion,
    generatedAt: new Date().toISOString(),
    evidences: input.evidences,
    grade: input.grade,
    attempts: input.attempts,
  };
}

export function summarizeEvidenceBundle(bundle: EvidenceBundle) {
  return {
    bundleId: bundle.bundleId,
    planId: bundle.planId,
    route: bundle.route,
    query: bundle.query,
    indexVersion: bundle.indexVersion,
    evidenceCount: bundle.evidences.length,
    evidenceIds: bundle.evidences.map((item) => item.evidenceId),
    grade: bundle.grade,
    attempts: bundle.attempts,
  };
}

export function mergeEvidenceBundles(bundles: EvidenceBundle[]) {
  const items = new Map<string, EvidenceItem>();
  for (const bundle of bundles) {
    for (const evidence of bundle.evidences) items.set(evidence.evidenceId, evidence);
  }
  return Array.from(items.values());
}

function evidenceId(source: string, documentId: string, version: string) {
  return `ev_${createHash("sha256")
    .update(`${source}:${documentId}:${version}`)
    .digest("hex")
    .slice(0, 12)}`;
}

function trustForUrl(url: string): EvidenceItem["trustLevel"] {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".gov") || host.endsWith(".gov.cn") || host.endsWith(".edu")) {
      return "public_primary";
    }
    if (/docs\.|developer\.|github\.com|wikipedia\.org/.test(host)) {
      return "public_secondary";
    }
  } catch {
    return "public_unverified";
  }
  return "public_unverified";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}
