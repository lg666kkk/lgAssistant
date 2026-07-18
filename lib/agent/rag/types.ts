export const AGENTIC_RAG_VERSION = "agentic-rag-v2";
export const WEB_RETRIEVAL_INDEX_VERSION = "web-live";

export type RetrievalRoute = "no_retrieval" | "knowledge" | "web" | "both";
export type RetrievalSource = "knowledge" | "web";
export type RetrievalQueryType = "exact" | "semantic" | "multi-hop" | "balanced";

export type RetrievalTimeRange = {
  from?: string;
  to?: string;
  label?: string;
};

export type RetrievalFilters = {
  pageIds?: string[];
  titleContains?: string;
  sourceTypes?: Array<"notion" | "document" | "web">;
  timeRange?: RetrievalTimeRange;
};

export type RetrievalPlanStep = {
  id: string;
  source: RetrievalSource;
  query: string;
  purpose: string;
  filters?: RetrievalFilters;
};

export type RetrievalPlan = {
  id: string;
  version: typeof AGENTIC_RAG_VERSION;
  route: RetrievalRoute;
  originalQuery: string;
  standaloneQuery: string;
  queryType: RetrievalQueryType;
  reason: string;
  confidence: number;
  evidenceRequired: boolean;
  maxAttempts: number;
  indexVersion: string;
  steps: RetrievalPlanStep[];
  createdAt: string;
};

export type EvidenceTrustLevel =
  | "private_user_content"
  | "public_primary"
  | "public_secondary"
  | "public_unverified";

export type EvidenceScores = {
  vector?: number;
  keyword?: number;
  fusion?: number;
  rerank?: number;
  crossEncoder?: number;
  provider?: number;
};

export type EvidenceCitation = {
  url?: string;
  headingPath?: string[];
  startChar?: number;
  endChar?: number;
  quotedText?: string;
};

export type EvidenceItem = {
  evidenceId: string;
  source: RetrievalSource;
  chunkId?: string;
  documentId: string;
  documentVersion: string;
  title: string;
  content: string;
  scores: EvidenceScores;
  trustLevel: EvidenceTrustLevel;
  citation: EvidenceCitation;
};

export type EvidenceGrade = {
  sufficient: boolean;
  grade: "strong" | "acceptable" | "weak" | "none";
  reason: string;
  topScore: number | null;
  scoreGap: number | null;
  queryCoverage: number;
  acceptedEvidenceIds: string[];
};

export type RetrievalAttempt = {
  attempt: number;
  source: RetrievalSource;
  query: string;
  threshold?: number;
  resultCount: number;
  cacheHit: boolean;
  rewriteReason?: string;
  grade: EvidenceGrade;
  timings?: Record<string, number>;
};

export type EvidenceBundle = {
  bundleId: string;
  version: typeof AGENTIC_RAG_VERSION;
  planId?: string;
  route: RetrievalRoute;
  query: string;
  indexVersion: string;
  generatedAt: string;
  evidences: EvidenceItem[];
  grade: EvidenceGrade;
  attempts: RetrievalAttempt[];
};

export type ClaimEvidenceCheck = {
  claim: string;
  citationIds: string[];
  unknownCitationIds: string[];
  supported: boolean;
  lexicalSupport: number;
};

export type GroundednessReport = {
  status: "pass" | "warn" | "fail";
  evidenceRequired: boolean;
  evidenceCount: number;
  claimCount: number;
  citedClaimCount: number;
  supportedClaimCount: number;
  citationPrecision: number;
  citationCoverage: number;
  groundedness: number;
  unknownCitationIds: string[];
  checks: ClaimEvidenceCheck[];
};

export function isEvidenceBundle(value: unknown): value is EvidenceBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Partial<EvidenceBundle>;
  return (
    typeof bundle.bundleId === "string" &&
    typeof bundle.query === "string" &&
    Array.isArray(bundle.evidences) &&
    Boolean(bundle.grade)
  );
}
