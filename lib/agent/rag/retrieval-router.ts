import { createHash } from "node:crypto";
import { extractNotionPageId } from "@/lib/knowledge/notion-page-id";
import {
  AGENTIC_RAG_VERSION,
  type RetrievalFilters,
  type RetrievalPlan,
  type RetrievalPlanStep,
  type RetrievalQueryType,
  type RetrievalRoute,
  type RetrievalSource,
} from "./types";

const KNOWLEDGE_CUES = /(?:我的|个人|之前|过去|曾经).{0,8}(?:笔记|文档|记录|资料|收藏|整理|写过)|(?:知识库|Notion|笔记里|文档里|记录里)|\b(?:my\s+(?:notes?|documents?|docs?|knowledge\s*base|notion)|(?:in|from|according\s+to)\s+my\s+(?:notes?|documents?|docs?|knowledge\s*base|notion)|what\s+did\s+i\s+(?:write|note|save|bookmark)|i\s+(?:wrote|noted|saved|bookmarked))\b/i;
const WEB_CUES = /(?:最新|今天|实时|新闻|价格|政策|发布|官网|公开资料|网上|联网|web|internet|近期(?:新闻|动态|政策|版本)|当前(?:价格|政策|版本|状态|排名|天气|汇率)|现在(?:价格|时间|天气|版本))|https?:\/\/|\b(?:latest|today|current|real[- ]?time|recent\s+(?:news|updates?)|news|price|policy|release|official\s+(?:site|docs?)|online|internet|search\s+the\s+web|look\s+up)\b/i;
const BOTH_CUES = /(?:结合|对比|比较|核对).{0,16}(?:我的|知识库|笔记|文档).{0,16}(?:最新|公开|网上|官网|新闻)|(?:我的|知识库|笔记|文档).{0,16}(?:和|与|以及).{0,16}(?:最新|公开|网上|官网|新闻)|\b(?:compare|combine|cross[- ]?check).{0,40}(?:my\s+(?:notes?|documents?|knowledge\s*base)).{0,40}(?:latest|public|official|web|news)|\b(?:my\s+(?:notes?|documents?|knowledge\s*base)).{0,40}(?:and|with|against).{0,40}(?:latest|public|official|web|news)\b/i;

export type BuildRetrievalPlanInput = {
  query: string;
  conversationContext?: string[];
  knowledgeProfile?: string;
  indexVersion?: string;
  webEnabled?: boolean;
  now?: Date;
};

const PLAN_CONTROL_MESSAGE = /^(?:执行已确认的计划|跳过失败步骤并继续执行计划|重试失败步骤)$/;

export function resolveRetrievalAnchor(
  messages: Array<{ role: string; content: string }>,
  usePriorTask: boolean,
) {
  const lastIndex = messages.length - 1;
  let selectedIndex = lastIndex;
  if (usePriorTask) {
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user" || !message.content.trim()) continue;
      if (PLAN_CONTROL_MESSAGE.test(message.content.trim())) continue;
      selectedIndex = index;
      break;
    }
  }
  const selected = messages[selectedIndex];
  return {
    query: selected?.role === "user" ? selected.content : "",
    foundPriorTask: !usePriorTask || selectedIndex < lastIndex,
    conversationContext: messages
      .slice(0, selectedIndex)
      .map((message) => message.content),
  };
}

export function buildRetrievalPlan(input: BuildRetrievalPlanInput): RetrievalPlan {
  const originalQuery = input.query.trim();
  const standaloneQuery = buildStandaloneQuery(originalQuery, input.conversationContext);
  const queryType = classifyQuery(standaloneQuery);
  const routeDecision = routeQuery({
    query: standaloneQuery,
    knowledgeProfile: input.knowledgeProfile,
    webEnabled: input.webEnabled !== false,
  });
  const filters = extractFilters(standaloneQuery, input.now ?? new Date());
  const sourceQueries = decomposeQuery(standaloneQuery, queryType);
  const sources = routeSources(routeDecision.route);
  const steps: RetrievalPlanStep[] = [];

  for (const source of sources) {
    for (let index = 0; index < Math.min(sourceQueries.length, 2); index += 1) {
      const query = sourceQueries[index];
      steps.push({
        id: `${source}-${index + 1}`,
        source,
        query,
        purpose: index === 0 ? "primary_retrieval" : "multi_hop_or_rewrite",
        filters: source === "knowledge" ? filters : webFilters(filters),
      });
    }
  }

  const indexVersion = input.indexVersion?.trim() || "index-unknown";
  const id = createHash("sha256")
    .update(JSON.stringify({ standaloneQuery, route: routeDecision.route, indexVersion, steps }))
    .digest("hex")
    .slice(0, 16);

  return {
    id: `retrieval-${id}`,
    version: AGENTIC_RAG_VERSION,
    route: routeDecision.route,
    originalQuery,
    standaloneQuery,
    queryType,
    reason: routeDecision.reason,
    confidence: routeDecision.confidence,
    evidenceRequired: routeDecision.evidenceRequired,
    maxAttempts: 2,
    indexVersion,
    steps,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function retrievalToolsForRoute(route: RetrievalRoute) {
  if (route === "no_retrieval") return new Set<string>();
  if (route === "knowledge") return new Set(["search_notes"]);
  if (route === "web") return new Set(["web_search", "web_fetch"]);
  return new Set(["search_notes", "web_search", "web_fetch"]);
}

export function filterToolsForRetrievalRoute<T extends { name: string }>(
  tools: T[],
  route: RetrievalRoute,
  options: { webEnabled?: boolean } = {},
) {
  const enabledTools = options.webEnabled === false
    ? tools.filter((tool) => tool.name !== "web_search" && tool.name !== "web_fetch")
    : tools;
  if (route === "no_retrieval") return enabledTools;
  const retrievalTools = new Set(["search_notes", "web_search", "web_fetch"]);
  const allowed = retrievalToolsForRoute(route);
  return enabledTools.filter((tool) => !retrievalTools.has(tool.name) || allowed.has(tool.name));
}

export function scopeRetrievalPlanToTools(
  plan: RetrievalPlan | undefined,
  toolNames: Iterable<string>,
): RetrievalPlan | undefined {
  if (!plan) return undefined;
  const names = new Set(toolNames);
  const sources = new Set<RetrievalSource>();
  if (names.has("search_notes")) sources.add("knowledge");
  if (names.has("web_search") || names.has("web_fetch")) sources.add("web");
  if (sources.size === 0) return undefined;

  const route: RetrievalRoute = sources.size === 2
    ? "both"
    : sources.has("knowledge")
      ? "knowledge"
      : "web";
  return {
    ...plan,
    route,
    steps: plan.steps.filter((step) => sources.has(step.source)),
  };
}

export function createRetryQuery(plan: RetrievalPlan, previousQuery: string) {
  const planned = plan.steps.find(
    (step) => step.query !== previousQuery && step.source === "knowledge",
  )?.query;
  if (planned) return { query: planned, reason: "planner_secondary_query" };

  const normalized = previousQuery
    .replace(/^(?:请问|帮我|如何|怎么|怎样|介绍一下|解释一下)/, "")
    .replace(/[？?。.!！]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const technicalTerms = previousQuery.match(
    /[A-Za-z_][A-Za-z0-9_\-./:]+|[A-Z]{2,}|[A-Z]+_[A-Z_]+|[\u4e00-\u9fff]{2,8}/g,
  );
  const query = technicalTerms?.slice(0, 8).join(" ") || normalized || plan.standaloneQuery;
  return { query, reason: "deterministic_evidence_rewrite" };
}

function routeQuery(input: {
  query: string;
  knowledgeProfile?: string;
  webEnabled: boolean;
}): {
  route: RetrievalRoute;
  reason: string;
  confidence: number;
  evidenceRequired: boolean;
} {
  const explicitKnowledge = KNOWLEDGE_CUES.test(input.query);
  const explicitWeb = WEB_CUES.test(input.query);
  const profileMatch = profileOverlap(input.query, input.knowledgeProfile) >= 0.18;

  if ((BOTH_CUES.test(input.query) || (explicitKnowledge && explicitWeb)) && input.webEnabled) {
    return {
      route: "both",
      reason: "query_requires_private_and_public_evidence",
      confidence: 0.95,
      evidenceRequired: true,
    };
  }
  if (explicitKnowledge) {
    return {
      route: "knowledge",
      reason: "explicit_private_knowledge_intent",
      confidence: 0.94,
      evidenceRequired: true,
    };
  }
  if (explicitWeb && input.webEnabled) {
    return {
      route: "web",
      reason: "fresh_or_public_information_required",
      confidence: 0.92,
      evidenceRequired: true,
    };
  }
  if (profileMatch) {
    return {
      route: "knowledge",
      reason: "knowledge_profile_match",
      confidence: 0.72,
      evidenceRequired: false,
    };
  }
  return {
    route: "no_retrieval",
    reason: "no_retrieval_signal",
    confidence: 0.78,
    evidenceRequired: false,
  };
}

function routeSources(route: RetrievalRoute): RetrievalSource[] {
  if (route === "knowledge") return ["knowledge"];
  if (route === "web") return ["web"];
  if (route === "both") return ["knowledge", "web"];
  return [];
}

function buildStandaloneQuery(query: string, context?: string[]) {
  const hasReference = /^(?:那|那么|它|这个|那个|上述|前者|后者|其|这些|那些|then\b|it\b|that\b|those\b)/i.test(query);
  if (!hasReference) return query;
  const background = (context ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .slice(-600);
  return background ? `${background}\n当前追问：${query}` : query;
}

function classifyQuery(query: string): RetrievalQueryType {
  if (/(?:比较|区别|关系|共同|分别|同时|为什么.*又|如何.*并|compare|versus|difference|relationship)/i.test(query)) {
    return "multi-hop";
  }
  if (/`[^`]+`|"[^"]+"|'[^']+'|[A-Z]{2,}[A-Z0-9_-]*|[A-Za-z]+Error|[A-Z]+_[A-Z_]+|\b\d{3,}\b/.test(query)) {
    return "exact";
  }
  if (query.length >= 24 || /(?:为什么|原理|如何设计|优缺点|解释|分析)/.test(query)) {
    return "semantic";
  }
  return "balanced";
}

function decomposeQuery(query: string, queryType: RetrievalQueryType) {
  if (queryType === "multi-hop") {
    const parts = query
      .split(/(?:和|与|以及|对比|比较|vs\.?|versus)/i)
      .map((part) => part
        .replace(/(?:之间)?(?:有(?:什么|哪些))?(?:区别|差异|关系)[？?。.!！]?$/i, "")
        .trim())
      .filter((part) => part.length >= 3);
    if (parts.length >= 2) {
      return parts.slice(0, 2).map((part) => part.slice(0, 240));
    }
  }

  const queries = new Set([query]);
  const compact = query
    .replace(/^(?:请问|帮我|如何|怎么|怎样|什么是|介绍一下|解释一下)/, "")
    .replace(/[？?。.!！]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact && compact !== query) queries.add(compact);
  return Array.from(queries).slice(0, 2);
}

function extractFilters(query: string, now: Date): RetrievalFilters | undefined {
  const filters: RetrievalFilters = {};
  const pageIds = query
    .match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27}/gi)
    ?.flatMap((value) => {
      const pageId = extractNotionPageId(value);
      return pageId ? [pageId] : [];
    });
  if (pageIds?.length) filters.pageIds = Array.from(new Set(pageIds));

  const title = query.match(/(?:标题|文档名|页面名)(?:包含|是|为)?[“"']([^”"']+)[”"']/)?.[1];
  if (title) filters.titleContains = title.trim().slice(0, 120);

  const sourceTypes: RetrievalFilters["sourceTypes"] = [];
  if (/Notion|笔记|文档|资料/i.test(query)) sourceTypes.push("notion");
  if (/(?:上传|导入|附件).{0,6}(?:文档|文件)|\b(?:uploaded|attached|imported)\s+(?:document|file)\b/i.test(query)) {
    sourceTypes.push("document");
  }
  if (sourceTypes.length) filters.sourceTypes = Array.from(new Set(sourceTypes));

  filters.timeRange = parseTimeRange(query, now);
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function parseTimeRange(query: string, now: Date) {
  const recent = query.match(/最近\s*(\d{1,3})\s*(天|周|个月|月)/);
  if (recent) {
    const amount = Number(recent[1]);
    const unitDays = recent[2] === "天" ? 1 : recent[2] === "周" ? 7 : 30;
    return {
      from: new Date(now.getTime() - amount * unitDays * 86_400_000).toISOString(),
      to: now.toISOString(),
      label: recent[0],
    };
  }
  if (/今年/.test(query)) {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString(),
      to: now.toISOString(),
      label: "今年",
    };
  }
  if (/去年/.test(query)) {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString(),
      to: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString(),
      label: "去年",
    };
  }
  const dates = query.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (dates?.length) {
    return {
      from: new Date(`${dates[0]}T00:00:00.000Z`).toISOString(),
      to: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`).toISOString(),
      label: dates.join(" 至 "),
    };
  }
  return undefined;
}

function webFilters(filters?: RetrievalFilters): RetrievalFilters | undefined {
  if (!filters?.timeRange) return undefined;
  return { sourceTypes: ["web"], timeRange: filters.timeRange };
}

function profileOverlap(query: string, profile?: string) {
  if (!profile?.trim()) return 0;
  const queryTerms = routeTerms(query);
  const profileTerms = routeTerms(profile);
  if (queryTerms.size === 0) return 0;
  let hits = 0;
  for (const term of Array.from(queryTerms)) {
    if (profileTerms.has(term)) hits++;
  }
  return hits / queryTerms.size;
}

function routeTerms(text: string) {
  const normalized = text.toLowerCase();
  const terms = new Set<string>();
  for (const token of normalized.match(/[a-z][a-z0-9_\-./]{2,}|[\u4e00-\u9fff]{2,12}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 4) {
      for (let index = 0; index <= token.length - 2; index++) {
        terms.add(token.slice(index, index + 2));
      }
    } else {
      terms.add(token);
    }
  }
  return terms;
}
