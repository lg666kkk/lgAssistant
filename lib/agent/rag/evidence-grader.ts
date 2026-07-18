import type { SearchResult } from "@/lib/knowledge/retriever";
import type { EvidenceGrade, EvidenceItem } from "./types";

export function gradeKnowledgeEvidence(
  query: string,
  results: SearchResult[],
  evidenceIds: string[],
): EvidenceGrade {
  const scored = results.map((result, index) => ({
    id: evidenceIds[index],
    score: knowledgeScore(result),
    coverage: lexicalCoverage(query, `${result.pageTitle} ${result.headingPath.join(" ")} ${result.content}`),
    dualSource: result.retrievalSources.length > 1,
  }));
  return gradeScored(scored);
}

export function gradeEvidenceItems(query: string, items: EvidenceItem[]): EvidenceGrade {
  return gradeScored(items.map((item) => ({
    id: item.evidenceId,
    score: Math.max(
      item.scores.crossEncoder ?? 0,
      item.scores.rerank ?? 0,
      item.scores.provider ?? 0,
      item.scores.vector ?? 0,
      item.scores.keyword ?? 0,
    ),
    coverage: lexicalCoverage(query, `${item.title} ${item.content}`),
    dualSource: false,
  })));
}

function gradeScored(items: Array<{
  id: string;
  score: number;
  coverage: number;
  dualSource: boolean;
}>): EvidenceGrade {
  if (items.length === 0) {
    return {
      sufficient: false,
      grade: "none",
      reason: "no_results",
      topScore: null,
      scoreGap: null,
      queryCoverage: 0,
      acceptedEvidenceIds: [],
    };
  }

  const sorted = [...items].sort((left, right) => right.score - left.score);
  const top = sorted[0];
  const second = sorted[1];
  const scoreGap = second ? Math.max(0, top.score - second.score) : null;
  const accepted = sorted.filter((item) =>
    item.score >= 0.35 && (item.coverage >= 0.12 || item.dualSource || item.score >= 0.6));
  const sufficient = accepted.length > 0 && (
    top.score >= 0.55 ||
    top.coverage >= 0.22 ||
    top.dualSource ||
    accepted.length >= 2
  );

  if (sufficient) {
    return {
      sufficient: true,
      grade: top.score >= 0.7 || top.coverage >= 0.35 ? "strong" : "acceptable",
      reason: top.dualSource
        ? "vector_keyword_agreement"
        : accepted.length >= 2
          ? "multiple_supporting_evidence"
          : "strong_single_evidence",
      topScore: top.score,
      scoreGap,
      queryCoverage: top.coverage,
      acceptedEvidenceIds: accepted.map((item) => item.id),
    };
  }

  return {
    sufficient: false,
    grade: "weak",
    reason: top.score < 0.35
      ? "low_top_score"
      : top.coverage < 0.12
        ? "low_query_coverage"
        : scoreGap !== null && scoreGap < 0.03
          ? "ambiguous_top_results"
          : "insufficient_evidence",
    topScore: top.score,
    scoreGap,
    queryCoverage: top.coverage,
    acceptedEvidenceIds: accepted.map((item) => item.id),
  };
}

function knowledgeScore(result: SearchResult) {
  return Math.max(
    result.crossEncoderScore ?? 0,
    result.rerankScore ?? result.combinedScore,
    result.similarity,
    result.keywordScore,
  );
}

function lexicalCoverage(query: string, text: string) {
  const queryTerms = tokenize(query);
  if (queryTerms.size === 0) return 0;
  const textTerms = tokenize(text);
  let hits = 0;
  for (const term of Array.from(queryTerms)) {
    if (textTerms.has(term)) hits++;
  }
  return hits / queryTerms.size;
}

function tokenize(text: string) {
  const normalized = text.toLowerCase();
  const terms = new Set<string>();
  for (const token of normalized.match(/[a-z0-9_\-./]{2,}|[\u4e00-\u9fff]{2,10}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index <= token.length - 2; index++) terms.add(token.slice(index, index + 2));
    } else {
      terms.add(token);
    }
  }
  return terms;
}
