import { mergeEvidenceBundles } from "./evidence";
import type {
  ClaimEvidenceCheck,
  EvidenceBundle,
  GroundednessReport,
} from "./types";

const CITATION_PATTERN = /\[(ev_[a-f0-9]{12})\]/g;

export function verifyGroundedAnswer(
  answer: string,
  bundles: EvidenceBundle[],
  options: { evidenceRequired?: boolean } = {},
): GroundednessReport {
  const evidences = mergeEvidenceBundles(bundles);
  const evidenceById = new Map(evidences.map((item) => [item.evidenceId, item]));
  const claims = splitClaims(answer);
  const checks: ClaimEvidenceCheck[] = claims.map((claim) => {
    const citationIds = Array.from(claim.matchAll(CITATION_PATTERN), (match) => match[1]);
    const unknownCitationIds = citationIds.filter((id) => !evidenceById.has(id));
    const knownEvidence = citationIds.flatMap((id) => {
      const evidence = evidenceById.get(id);
      return evidence ? [evidence] : [];
    });
    const lexicalSupport = knownEvidence.length === 0
      ? 0
      : Math.max(...knownEvidence.map((item) => lexicalOverlap(claim, `${item.title} ${item.content}`)));
    return {
      claim,
      citationIds,
      unknownCitationIds,
      supported: knownEvidence.length > 0 && unknownCitationIds.length === 0 && lexicalSupport >= 0.08,
      lexicalSupport,
    };
  });
  const citationCount = checks.reduce((sum, check) => sum + check.citationIds.length, 0);
  const supportedCitationCount = checks.reduce((sum, check) => {
    const claimWithoutCitations = check.claim.replace(CITATION_PATTERN, "");
    return sum + check.citationIds.filter((id) => {
      const evidence = evidenceById.get(id);
      return evidence
        ? lexicalOverlap(claimWithoutCitations, `${evidence.title} ${evidence.content}`) >= 0.08
        : false;
    }).length;
  }, 0);
  const citedClaimCount = checks.filter((check) => check.citationIds.length > 0).length;
  const supportedClaimCount = checks.filter((check) => check.supported).length;
  const citationPrecision = citationCount > 0 ? supportedCitationCount / citationCount : 0;
  const citationCoverage = checks.length > 0 ? citedClaimCount / checks.length : 1;
  const groundedness = checks.length > 0 ? supportedClaimCount / checks.length : 1;
  const unknownCitationIds = Array.from(new Set(checks.flatMap((check) => check.unknownCitationIds)));
  const evidenceRequired = options.evidenceRequired === true;
  const status = evidences.length === 0
    ? evidenceRequired ? "fail" : "pass"
    : unknownCitationIds.length > 0 || groundedness < 0.5 || citationPrecision < 0.5
      ? "fail"
      : citationCoverage < 0.8 || groundedness < 0.75 || citationPrecision < 0.8
        ? "warn"
        : "pass";

  return {
    status,
    evidenceRequired,
    evidenceCount: evidences.length,
    claimCount: checks.length,
    citedClaimCount,
    supportedClaimCount,
    citationPrecision,
    citationCoverage,
    groundedness,
    unknownCitationIds,
    checks,
  };
}

export function applyGroundednessGuard(answer: string, report: GroundednessReport) {
  if (report.status === "pass") return answer;
  if (report.evidenceCount === 0) {
    return "当前检索未获得足够证据，无法可靠回答。";
  }
  const notice = report.status === "fail"
    ? "证据校验未通过：部分事实缺少有效引用或与引用证据的词面支持不足，请将未引用内容视为不确定。"
    : "证据校验提示：部分事实的引用覆盖不足。";
  return `${answer.trim()}\n\n${notice}`;
}

function splitClaims(answer: string) {
  return answer
    .split(/(?<=[。！？!?；;])(?!(?:\s*\[ev_[a-f0-9]{12}\]))|\n+/)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length >= 8)
    .filter((claim) => !/^(?:证据校验|来源|参考|注意|说明)[:：]/.test(claim));
}

function lexicalOverlap(claim: string, evidence: string) {
  const claimTerms = tokenize(claim.replace(CITATION_PATTERN, ""));
  if (claimTerms.size === 0) return 0;
  const evidenceTerms = tokenize(evidence);
  let hits = 0;
  for (const term of Array.from(claimTerms)) {
    if (evidenceTerms.has(term)) hits++;
  }
  return hits / claimTerms.size;
}

function tokenize(text: string) {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9_\-./]{2,}|[\u4e00-\u9fff]{2,8}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index <= token.length - 2; index++) terms.add(token.slice(index, index + 2));
    } else {
      terms.add(token);
    }
  }
  return terms;
}
