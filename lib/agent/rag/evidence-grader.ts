import type { SearchResult } from "@/lib/knowledge/retriever";
import { lexicalTerms, queryTerms, termCoverage } from "@/lib/knowledge/lexical";
import type { EvidenceGrade, EvidenceItem } from "./types";

type ScoredEvidence = {
  id: string;
  group: string;
  score: number;
  content: string;
  dualSource: boolean;
};

export function gradeKnowledgeEvidence(
  query: string,
  results: SearchResult[],
  evidenceIds: string[],
): EvidenceGrade {
  const grade = gradeScored(query, results.map((result, index) => ({
    id: evidenceIds[index],
    group: result.parentKey ? `${result.pageId}:${result.parentKey}` : result.pageId,
    score: knowledgeScore(result),
    // Titles identify a source; they do not establish that its body answers the question.
    content: result.content,
    dualSource: result.retrievalSources.length > 1,
  })));
  const visualCandidates = results.flatMap((result, index) =>
    result.metadata?.content_kind === 'visual_proxy' && knowledgeScore(result) >= 0.35
      ? [evidenceIds[index]] : []);
  if (!visualCandidates.length) return grade;
  // Relevant locations can be read before their facts are answerable. Retain candidates,
  // but never let a proxy-only hit count as a fully sufficient visual answer.
  return { ...grade, sufficient: false, grade: 'weak', reason: 'visual_verification_pending',
    acceptedEvidenceIds: Array.from(new Set([...grade.acceptedEvidenceIds, ...visualCandidates])) };
}

export function gradeEvidenceItems(query: string, items: EvidenceItem[]): EvidenceGrade {
  return gradeWebScored(items.map((item) => ({
    id: item.evidenceId,
    score: item.scores.crossEncoder ?? Math.max(
      item.scores.rerank ?? 0,
      item.scores.provider ?? 0,
      item.scores.vector ?? 0,
      item.scores.keyword ?? 0,
    ),
    coverage: lexicalCoverage(query, `${item.title} ${item.content}`),
    dualSource: false,
  })));
}

function gradeScored(query: string, items: ScoredEvidence[]): EvidenceGrade {
  if (items.length === 0) {
    return { sufficient: false, grade: "none", reason: "no_results", topScore: null,
      scoreGap: null, queryCoverage: 0, acceptedEvidenceIds: [] };
  }
  const terms = queryTerms(query);
  const sorted = items.map((item) => ({ ...item, coverage: termCoverage(terms, item.content) }))
    .sort((left, right) => right.score - left.score);
  const top = sorted[0];
  const second = sorted[1];
  const scoreGap = second ? Math.max(0, top.score - second.score) : null;
  const accepted = sorted.filter((item) => Number.isFinite(item.score)
    && item.score >= 0.35 && item.coverage >= 0.12);
  const covered = new Set<string>();
  for (const item of accepted) {
    for (const term of Array.from(lexicalTerms(item.content))) if (terms.has(term)) covered.add(term);
  }
  const coverage = terms.size ? covered.size / terms.size : 0;
  const content = accepted.map((item) => item.content).join("\n").toLowerCase();
  // Preserve quoted entities and numerical conditions, even if other terms overlap.
  const required = [
    ...Array.from(query.matchAll(/[`"“]([^`"”]+)[`"”]/g), (match) => match[1].toLowerCase()),
    ...(query.match(/\b\d+(?:\.\d+)?\b/g) ?? []),
  ];
  const missingCondition = required.some((value) => /\d/.test(value) && /^\d+(?:\.\d+)?$/.test(value)
    ? !lexicalTerms(content).has(value) : !content.includes(value));
  const strongSingle = accepted.some((item) => item.coverage >= 0.65
    && (item.score >= 0.55 || item.dualSource));
  const independentSources = new Set(accepted.map((item) => item.group)).size >= 2;
  const sufficient = !missingCondition && coverage >= 0.65 && (strongSingle || independentSources);
  return {
    sufficient,
    grade: sufficient ? coverage >= 0.85 && accepted[0].score >= 0.7 ? "strong" : "acceptable" : "weak",
    reason: sufficient
      ? strongSingle ? accepted.some((item) => item.dualSource && item.coverage >= 0.65)
        ? "vector_keyword_agreement" : "strong_single_evidence" : "multiple_supporting_evidence"
      : top.score < 0.35 ? "low_top_score"
        : accepted.length === 0 ? "low_query_coverage"
          : missingCondition ? "missing_query_condition"
            : coverage < 0.65 ? "incomplete_query_coverage" : "insufficient_independent_evidence",
    topScore: top.score,
    scoreGap,
    queryCoverage: coverage,
    acceptedEvidenceIds: accepted.map((item) => item.id),
  };
}

export function knowledgeScore(result: SearchResult) {
  // Ranking/fusion scores are relative to the candidate pool, not confidence.
  if (result.crossEncoderScore !== undefined) return result.crossEncoderScore;
  return Math.max(result.similarity, result.keywordRank ?? result.keywordScore);
}

// Web evidence retains its existing provider confidence policy.
function gradeWebScored(items: Array<{
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
