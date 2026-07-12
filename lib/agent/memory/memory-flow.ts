import Anthropic from "@anthropic-ai/sdk";
import { deepseekConfig } from "@/lib/platform/config";
import { LongTermStore } from "./longterm-store";
import { SemanticStore } from "./semantic-store";
import type { MemoryRecord } from "./types";

/**
 * 记忆流动编排层：连接「主循环」与「三层存储」。
 * 只负责「何时召回 / 何时沉淀」，存取细节交给各 store —— 自己不碰数据库。
 *
 *   ① recallForPrompt  对话开始前：召回相关记忆 → 拼成注入 system 的文本
 *   ③ consolidate      对话结束后：用 LLM 抽取「值得长期记住的事实」→ 写回
 */

const longTerm = new LongTermStore();
const semantic = new SemanticStore();

// 抽取用的 client：完全照抄 runtime/index.ts 的写法，保证鉴权方式一致
const client = new Anthropic({
  apiKey: deepseekConfig.apiKey,
  baseURL: deepseekConfig.baseURL,
});
const EXTRACT_MODEL = deepseekConfig.model;
const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_RECALL_THRESHOLD = 0.68;

function readRecallNumber(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const recallLimit = readRecallNumber("MEMORY_RECALL_LIMIT", DEFAULT_RECALL_LIMIT, 1, 10);
const recallThreshold = readRecallNumber(
  "MEMORY_RECALL_THRESHOLD",
  DEFAULT_RECALL_THRESHOLD,
  0,
  1,
);
const MEMORY_RECALL_QUERY_PATTERN =
  /(?:长期记忆|历史记忆|记忆库|个人(?:资料|信息|背景|画像)|还记得|记得我|之前(?:说|聊|提|告诉|做)|上次(?:说|聊|提|做)|延续(?:上次|之前)|继续(?:上次|之前)|我的(?:偏好|习惯|资料|信息|背景|情况|计划|目标|项目|需求)|我(?:最|很|比较|特别)?喜欢(?:吃)?|我(?:最)?爱吃|我(?:的)?(?:口味|饮食)(?:偏好|习惯)|我(?:不喜欢|习惯|偏好|过敏|忌口|常用|在意)|适合我|为我推荐|根据我|\b(?:remember|memory|memories|my preferences|my profile|based on my|continue (?:our |the )?(?:previous|last))\b)/i;

/**
 * 仅在当前问题可能依赖用户画像或跨会话历史时召回长期记忆。
 * 普通知识问答、临时任务和寒暄不需要额外 embedding / 数据库查询。
 */
export function shouldRecallLongTermMemory(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return false;

  return MEMORY_RECALL_QUERY_PATTERN.test(normalized);
}

// ============================================================
// ① 召回：把和当前问题相关的记忆，拼成一段注入 system 的文本
// ============================================================
export async function recallForPrompt(
  query: string,
  opts: { limit?: number; threshold?: number; userId?: string } = {},
): Promise<string> {
  if (!opts.userId || !shouldRecallLongTermMemory(query)) return "";

  const threshold = opts.threshold ?? recallThreshold;
  const hits = await semantic.recall(query, opts.limit ?? recallLimit, {
    userId: opts.userId,
    threshold,
  });
  const relevantHits = hits.filter(
    (hit) => typeof hit.score === "number" && hit.score >= threshold,
  );
  if (relevantHits.length === 0) return ""; // 没有足够相关的记忆就不注入 system

  const lines = relevantHits.map((h) => `- ${h.content}`).join("\n");
  return [
    "以下是可能相关的用户长期记忆，仅作为候选背景：",
    lines,
    "仅当某条记忆与当前问题直接相关时才可使用；无关时忽略。不要把记忆当作当前问题的事实，不能仅凭记忆替代对当前问题的回答。",
  ].join("\n");
}

// ============================================================
// ③ 沉淀：用 LLM 判断对话里哪些信息值得长期记住，写回记忆库
// ============================================================

// LLM 抽取的单条事实
interface ExtractedFact {
  fact: string; // 事实正文，如「用户对香菜过敏」
  key: string; // 业务键，用于去重/覆盖，如「diet:allergy:cilantro」
}

// tool_choice 强制模式不兼容 thinking 模式，改用 JSON prompt 方案：
// 直接让模型输出 JSON 字符串，手动解析，不依赖 tools/tool_choice。
const EXTRACT_PROMPT = `你是记忆抽取器。读下面这段对话，只抽出「值得长期记住的用户事实」。

规则：
- 该记：用户的偏好、习惯、身份、长期约束（如过敏、惯用语言、代码风格）
- 不该记：一次性任务（如「帮我算 3+5」）、临时问题、寒暄

直接输出 JSON，不要任何解释，格式如下：
{"facts":[{"fact":"事实内容，第三人称陈述","key":"稳定业务键如diet:allergy"}]}

如果没有值得记的事实，输出：{"facts":[]}`;

export async function consolidate(
  conversation: { role: string; content: string }[],
  opts: { sessionId?: string; userId?: string } = {},
): Promise<MemoryRecord[]> {
  if (conversation.length === 0) return [];
  if (!opts.userId) return [];

  // 把对话拼成纯文本喂给抽取器
  const transcript = conversation
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  let facts: ExtractedFact[] = [];
  try {
    const res = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages: [{ role: "user", content: transcript }],
      // 不用 tools/tool_choice：thinking 模式不支持强制 tool_choice，改用 JSON prompt
    });
    // 取模型输出的文本，找到第一个 JSON 对象
    const text = (res.content.find((b: any) => b.type === "text") as any)?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      facts = (parsed.facts ?? []) as ExtractedFact[];
    }
  } catch (e: any) {
    console.error("[consolidate] 抽取失败:", e.message);
    return [];
  }

  // 写回长期记忆。key 只用模型生成的业务键，不带 sessionId。
  // 用户偏好是跨会话共享的事实，带 sessionId 会导致同一事实每次新会话都重复插入。
  const saved: MemoryRecord[] = [];
  for (const f of facts) {
    if (!f.fact || !f.key) continue;
    const ns = f.key;
    // 同时写长期（按 key 取）和语义（按意思召回）—— 一条事实两种检索方式都能找到
    await longTerm.set(
      ns,
      f.fact,
      { sessionId: opts.sessionId, source: "consolidate" },
      { userId: opts.userId },
    );
    await semantic.set(
      ns,
      f.fact,
      { sessionId: opts.sessionId, source: "consolidate" },
      { userId: opts.userId },
    );
    saved.push({
      id: "",
      key: ns,
      layer: "longterm",
      content: f.fact,
      metadata: { source: "consolidate" },
      createdAt: "",
    });
  }
  return saved;
}
