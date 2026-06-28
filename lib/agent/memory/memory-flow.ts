import Anthropic from "@anthropic-ai/sdk";
import { deepseekConfig } from "@/lib/config";
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

// ============================================================
// ① 召回：把和当前问题相关的记忆，拼成一段注入 system 的文本
// ============================================================
export async function recallForPrompt(
  query: string,
  opts: { limit?: number; userId?: string } = {},
): Promise<string> {
  const hits = await semantic.recall(query, opts.limit ?? 5, { userId: opts.userId });
  if (hits.length === 0) return ""; // 没召回到就返回空串，调用方不注入 system

  const lines = hits.map((h) => `- ${h.content}`).join("\n");
  // 这段会作为 system prompt 注入，告诉模型「这些是关于用户的已知背景」
  return `以下是关于用户的已知信息（来自历史记忆），回答时请参考：\n${lines}`;
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
