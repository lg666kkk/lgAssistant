import type { RetrievalRoute } from "@/lib/agent/rag/types";

export type RetrievalRoutingCase = {
  id: string;
  query: string;
  expectedRoute: RetrievalRoute;
  knowledgeProfile?: string;
  webEnabled?: boolean;
};

export type RetrievalRoutingPrediction = RetrievalRoutingCase & {
  predictedRoute: RetrievalRoute;
  reason: string;
};

type BinaryMetrics = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
};

export function summarizeRetrievalRouting(
  predictions: RetrievalRoutingPrediction[],
) {
  const correct = predictions.filter(
    (prediction) => prediction.expectedRoute === prediction.predictedRoute,
  ).length;
  const knowledge = binaryMetrics(
    predictions,
    (route) => route === "knowledge" || route === "both",
  );
  const web = binaryMetrics(
    predictions,
    (route) => route === "web" || route === "both",
  );
  const retrieval = binaryMetrics(
    predictions,
    (route) => route !== "no_retrieval",
  );

  return {
    cases: predictions.length,
    correct,
    accuracy: predictions.length > 0 ? correct / predictions.length : 0,
    knowledge,
    web,
    retrieval,
  };
}

function binaryMetrics(
  predictions: RetrievalRoutingPrediction[],
  isPositive: (route: RetrievalRoute) => boolean,
): BinaryMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;

  for (const prediction of predictions) {
    const expected = isPositive(prediction.expectedRoute);
    const actual = isPositive(prediction.predictedRoute);
    if (expected && actual) truePositive += 1;
    else if (!expected && actual) falsePositive += 1;
    else if (expected) falseNegative += 1;
    else trueNegative += 1;
  }

  const precision = truePositive + falsePositive > 0
    ? truePositive / (truePositive + falsePositive)
    : 1;
  const recall = truePositive + falseNegative > 0
    ? truePositive / (truePositive + falseNegative)
    : 1;
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;
  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1,
  };
}
