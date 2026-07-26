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
  // 控制条件化工具编排（例如实时公开信息先获取当前时间），不等同于必须引用。
  freshnessRequired?: boolean;
  // 请求是否明确要求外部来源；实际工具也可通过 outputPolicy 追加引用要求。
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
  /** 同一节内被引用过的证据序号，用于定位继承来源。 */
  scope: number;
  /** 自身没有引用，但被同节已引用证据以最低词面支持线覆盖。 */
  inherited: boolean;
};

export type GroundednessReport = {
  status: "pass" | "warn" | "fail";
  evidenceRequired: boolean;
  evidenceCount: number;
  claimCount: number;
  /** 自身写了引用的 claim 数，不含作用域继承。 */
  citedClaimCount: number;
  /** citationCoverage 的分子：自身有引用，或被同节引用证据覆盖。 */
  coveredClaimCount: number;
  /** groundedness 的分子：自身或继承达到最低词面支持线。 */
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
