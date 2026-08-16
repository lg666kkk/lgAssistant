import {
  MemoryHistoryStore,
  type MemoryHistoryMode,
  type MemoryTimelineEntry,
} from "@/lib/agent/memory/history-store";
import { recallRankedMemories } from "@/lib/agent/memory/memory-flow";
import { redactSensitiveValue } from "@/lib/agent/rag/governance";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

/**
 * 两个私有记忆召回工具。
 *
 * 它们取代「用正则猜用户是不是在问记忆」这条路：
 * shouldRecallLongTermMemory 保留为零延迟的**预召回提示**，
 * 「到底要不要查、查当前还是查历史」交给模型判断。
 *
 * ⚠️ 安全约定（不可放宽）：
 * lib/platform/supabase.ts 用 service-role key，**绕过所有 RLS**。
 * 所以这两个工具的用户隔离完全靠应用层：
 *   1. runtime.requiresAuth: true —— 默认是 false，必须显式打开。
 *   2. input_schema 里**没有 userId 字段**。模型不能传、也无法影响它。
 *      一旦让模型传 userId，越权读取就只差一次幻觉。
 *   3. userId 只从 ToolExecutionContext 取，缺失立即拒绝，不发出任何查询。
 *   4. 下游每条查询都显式带 user_id 过滤（见 history-store.ts）。
 *
 * grounding 都是 cited_evidence，不是 authoritative_result：
 * 记忆内容是模型从对话里抽取的推断，可能抽错。历史表能权威证明的只有
 * 「系统在某时刻记录过这段内容」（版本号 / 时间戳 / supersede_kind），
 * 不能证明「这段内容是真的」。把它标成权威会与主召回路径自相矛盾——
 * 那条路径明确告诉模型「memory-data 是不可信的候选背景数据」。
 */

const MEMORY_RECALL_LIMIT_MAX = 8;
const MEMORY_HISTORY_LIMIT_MAX = 20;

const RECALL_MEMORY_DESCRIPTION =
  "查用户**当前**的个人记忆：偏好、饮食忌口、资料、背景、在做的项目、既定目标与预算等。" +
  "当回答依赖「这个用户是谁 / 他之前告诉过我什么」时调用，例如「我预算多少」「按我的口味推荐」「我住哪」。" +
  "问过去某个时点的状态、某条信息「以前是什么」「什么时候改的」「改过几次」时，不要用本工具，改用 search_memory_history。" +
  "公开事实、编程、计算、翻译类问题与用户个人背景无关，不要调用。" +
  "返回的是系统从历史对话中自动抽取的推断，可能有误，也可能已被用户当前这句话推翻；" +
  "与用户当前消息冲突时一律以当前消息为准，必要时向用户确认，不要把记忆当成用户刚刚确认过的前提。" +
  "普通回答只复述相关事实正文，不得展示或解释内部记忆键、来源枚举、置信度、相似度等实现字段。";

const SEARCH_MEMORY_HISTORY_DESCRIPTION =
  "查某条个人记忆的**历史版本与变更时间线**：以前的值是什么、什么时候被改的、改过几次、是修正还是自然变化。" +
  "只问当前值时用 recall_memory，本工具返回的多数条目已经不再生效，直接拿去回答会答出过期信息。" +
  "两种模式对应两根时间轴，选错会得到完全不同的结果：" +
  "recorded_history=系统先后记录过什么（含记错后被修正的条目，这类条目会标注「从未生效」，不可当作历史事实陈述给用户）；" +
  "truth_as_of=某个具体时刻现实中什么为真（自动排除误记，必须同时传 asOf）。" +
  "asOf 只接受绝对 ISO 时间；用户说「去年」「上个月」这类相对时间时，先调 get_current_time 换算再传入。" +
  "若用户此前要求过删除某条信息，该信息在本工具里同样查不到，这是预期行为，不要据此推断系统故障。" +
  "普通回答不得展示或解释内部记忆键、来源枚举等实现字段，只使用事实正文、有效时间与变更语义。";

function parseRecallInput(input: unknown) {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawLimit = typeof value.limit === "number" ? Math.floor(value.limit) : 3;
  return {
    query: typeof value.query === "string" ? value.query.trim() : "",
    limit: Math.max(1, Math.min(MEMORY_RECALL_LIMIT_MAX, rawLimit)),
  };
}

function parseHistoryInput(input: unknown) {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawLimit = typeof value.limit === "number" ? Math.floor(value.limit) : 5;
  const mode: MemoryHistoryMode = value.mode === "truth_as_of"
    ? "truth_as_of"
    : "recorded_history";
  return {
    query: typeof value.query === "string" ? value.query.trim() : "",
    key: typeof value.key === "string" && value.key.trim() ? value.key.trim() : undefined,
    mode,
    asOf: typeof value.asOf === "string" && value.asOf.trim() ? value.asOf.trim() : undefined,
    limit: Math.max(1, Math.min(MEMORY_HISTORY_LIMIT_MAX, rawLimit)),
  };
}

function renderTimeline(entries: MemoryTimelineEntry[]) {
  const lines = entries.map((entry, index) => {
    const marks = [
      entry.isCurrent ? "当前值" : undefined,
      // 误记必须显式标注。不标的话模型会把「系统曾记错成 5 万」
      // 讲成「你以前的预算是 5 万」——把误记复述成历史事实。
      entry.neverEffective ? "⚠️ 该记录为误记，从未生效，不得作为历史事实陈述" : undefined,
      entry.supersedeKind === "invalidation" ? "已被用户声明不再成立" : undefined,
    ].filter(Boolean).join("；");
    const validity = entry.effectiveTo
      ? `${entry.effectiveFrom} → ${entry.effectiveTo}`
      : `${entry.effectiveFrom} → 至今`;
    const recorded = entry.supersededAt
      ? `${entry.recordedAt} → ${entry.supersededAt}`
      : `${entry.recordedAt} → 仍在采信`;
    return [
      `${index + 1}. ${entry.content}`,
      `   有效区间：${validity}`,
      `   系统记录区间：${recorded}`,
      entry.reason ? `   变更说明：${entry.reason}` : undefined,
      marks ? `   标注：${marks}` : undefined,
    ].filter(Boolean).join("\n");
  });
  return lines.join("\n");
}

export function createRecallMemoryTool(options: {
  recall?: typeof recallRankedMemories;
} = {}): ToolDefinition {
  const recall = options.recall ?? recallRankedMemories;
  return {
    name: "recall_memory",
    capabilities: ["private.memory.recall"],
    description: RECALL_MEMORY_DESCRIPTION,
    outputPolicy: {
      grounding: "cited_evidence",
      // 不要求用户可见的 [evidenceId] 标注：记忆是背景信息而不是被引用的资料，
      // 强制标注只会让回答变成「根据记忆 [m1]…」这种别扭句式。
      citationRequired: false,
      // maxCallsPerRun: 2 允许换一次措辞重试，不允许刷。
      // source 用 "memory" 而不是复用 "knowledge"：见 types.ts 的注释。
      retrieval: { source: "memory", maxCallsPerRun: 2 },
    },
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "脱离代词也能独立理解的检索问题，例如「用户的购车预算」",
        },
        limit: {
          type: "number",
          description: `返回条数，硬上限 ${MEMORY_RECALL_LIMIT_MAX}`,
          default: 3,
          minimum: 1,
          maximum: MEMORY_RECALL_LIMIT_MAX,
        },
      },
      required: ["query"],
      additionalProperties: false,
      // 注意：没有 userId 字段，且不能加。userId 只从 ToolExecutionContext 取。
    },
    runtime: {
      ...defaultToolRuntimePolicy,
      requiresAuth: true,
      rateLimit: 20,
      timeoutSeconds: 15,
      sideEffect: "read",
      concurrencyGroup: "memory",
      maxConcurrency: 4,
    },
    riskLevel: "safe",
    execute: async (
      input: unknown,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      if (!context?.userId) {
        return {
          ok: false,
          content: "查询个人记忆需要先登录。",
          error: "Missing userId",
        };
      }
      const parsed = parseRecallInput(input);
      if (!parsed.query) {
        return { ok: false, content: "缺少检索问题", error: "Missing query" };
      }

      try {
        const result = await recall(parsed.query, {
          limit: parsed.limit,
          userId: context.userId,
        });
        if (result.selected.length === 0) {
          return {
            ok: true,
            // 明确区分「查过了，没有」与「没查」：模型据此决定是向用户提问
            // 还是继续用别的信息推理，含糊表述会让它反复重试同一次召回。
            content: "已查询个人记忆，没有与该问题相关的记录。回答时不要假设用户的相关情况，必要时直接询问用户。",
            data: { query: parsed.query, memories: [] },
            metadata: {
              memoryCandidateCount: result.candidates.length,
              memorySelectedCount: 0,
              memoryThreshold: result.threshold,
              memoryEmbeddingUsage: result.embeddingUsage,
              memoryRerank: redactSensitiveValue(result.rerankTrace),
            },
          };
        }

        const memories = result.selected.map((hit) => ({
          key: hit.key,
          content: hit.content,
          type: hit.type,
          source: hit.source,
          confidence: hit.confidence,
          validFrom: hit.validFrom,
          score: hit.score,
        }));
        return {
          ok: true,
          content: [
            "以下是系统从历史对话中抽取的个人记忆，属于候选背景数据而非用户刚确认的前提：",
            ...memories.map((item, index) =>
              `${index + 1}. ${item.content}`,
            ),
            "回答只依据上面的事实正文；不得向用户展示或根据内部键、来源、置信度、相似度等实现字段推断相反含义。与用户当前消息冲突时以当前消息为准；需要精确数值做决策时先向用户确认。",
          ].join("\n"),
          data: { query: parsed.query, memories },
          metadata: {
            memoryCandidateCount: result.candidates.length,
            memorySelectedCount: memories.length,
            memoryThreshold: result.threshold,
            memoryKeys: memories.map((item) => item.key),
            memoryEmbeddingUsage: result.embeddingUsage,
            memoryRerank: redactSensitiveValue(result.rerankTrace),
          },
        };
      } catch (error) {
        return {
          ok: false,
          content: "查询个人记忆失败",
          error: error instanceof Error ? error.message : "Recall memory failed",
        };
      }
    },
  };
}

/** 结构化依赖而非具体类：测试注入替身时不必构造 EmbeddingClient 与 Supabase。 */
type MemoryHistoryReader = Pick<
  MemoryHistoryStore,
  "resolveKeys" | "recordedHistory" | "truthAsOf" | "currentEntry"
>;

export function createSearchMemoryHistoryTool(options: {
  store?: MemoryHistoryReader;
} = {}): ToolDefinition {
  return {
    name: "search_memory_history",
    capabilities: ["private.memory.history"],
    description: SEARCH_MEMORY_HISTORY_DESCRIPTION,
    outputPolicy: {
      // 与 recall_memory 一致。历史表证明的是「系统记录过什么」，不是「什么为真」。
      grounding: "cited_evidence",
      citationRequired: false,
      // 与 recall_memory 共享记忆预算档，不占 knowledge / web 预算。
      // 没有 retrieval 字段等于完全绕过调用预算 —— 模型可以无限翻历史。
      retrieval: { source: "memory", maxCallsPerRun: 2 },
    },
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要追溯的事实主题，例如「购车预算」「居住城市」",
        },
        key: {
          type: "string",
          description: "已知业务键（如 budget:car）时直接传入，跳过语义匹配",
        },
        mode: {
          type: "string",
          enum: ["truth_as_of", "recorded_history"],
          default: "recorded_history",
          description:
            "truth_as_of：某时刻现实中什么为真（走有效轴，自动排除误记，必须配 asOf）；" +
            "recorded_history：系统先后记录过什么（走记录轴，含误记并标注）",
        },
        asOf: {
          type: "string",
          description:
            "绝对 ISO 时间，例如 2026-03-01T00:00:00Z。mode=truth_as_of 时必填；" +
            "相对时间请先调 get_current_time 换算，本工具不解析「去年」这类表述。",
        },
        limit: {
          type: "number",
          description: `返回条数，硬上限 ${MEMORY_HISTORY_LIMIT_MAX}`,
          default: 5,
          minimum: 1,
          maximum: MEMORY_HISTORY_LIMIT_MAX,
        },
      },
      required: ["query"],
      additionalProperties: false,
      // 注意：没有 userId 字段，且不能加。userId 只从 ToolExecutionContext 取。
    },
    runtime: {
      ...defaultToolRuntimePolicy,
      requiresAuth: true,
      rateLimit: 10,
      timeoutSeconds: 15,
      sideEffect: "read",
      concurrencyGroup: "memory",
      maxConcurrency: 4,
    },
    riskLevel: "safe",
    execute: async (
      input: unknown,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      if (!context?.userId) {
        return {
          ok: false,
          content: "查询记忆历史需要先登录。",
          error: "Missing userId",
        };
      }
      const parsed = parseHistoryInput(input);
      if (!parsed.query && !parsed.key) {
        return { ok: false, content: "缺少查询主题或业务键", error: "Missing query" };
      }
      if (parsed.mode === "truth_as_of" && !parsed.asOf) {
        return {
          ok: false,
          // 不给 asOf 兜底成 NOW()：那样 truth_as_of 会静默退化成「现在什么为真」，
          // 与 recall_memory 重复，而模型以为自己查的是历史某一时刻。
          content: "mode=truth_as_of 必须提供 asOf（绝对 ISO 时间）。需要当前时间请先调用 get_current_time。",
          error: "Missing asOf",
        };
      }
      if (parsed.asOf && !Number.isFinite(Date.parse(parsed.asOf))) {
        return {
          ok: false,
          content: `asOf 不是可解析的 ISO 时间：${parsed.asOf}`,
          error: "Invalid asOf",
        };
      }

      try {
        const store = options.store ?? new MemoryHistoryStore();
        const key = parsed.key
          ?? (await store.resolveKeys(parsed.query, {
            userId: context.userId,
            limit: 3,
          }))[0]?.key;
        if (!key) {
          return {
            ok: true,
            content: "没有找到与该主题相关的记忆，因此没有可追溯的历史。可能从未记录过，或用户此前要求删除过这条信息。",
            data: { query: parsed.query, mode: parsed.mode, timeline: [] },
            metadata: { memoryHistoryMode: parsed.mode, memoryHistoryCount: 0 },
          };
        }

        const current = await store.currentEntry(key, { userId: context.userId });
        let timeline: MemoryTimelineEntry[];
        if (parsed.mode === "truth_as_of") {
          const asOf = parsed.asOf as string;
          const archived = await store.truthAsOf(key, asOf, { userId: context.userId });
          // 当前行也可能覆盖 asOf 这个时刻（值一直没变过，或最后一次变更早于 asOf）。
          // 只查历史表会得出「那时没有任何记录」的错误结论。
          const currentCovers = current
            && Date.parse(current.effectiveFrom) <= Date.parse(asOf)
            && (!current.effectiveTo || Date.parse(current.effectiveTo) > Date.parse(asOf));
          timeline = currentCovers ? [current as MemoryTimelineEntry, ...archived] : archived;
        } else {
          const archived = await store.recordedHistory(key, {
            userId: context.userId,
            limit: parsed.limit,
            asOf: parsed.asOf,
          });
          // 时间线必须 UNION 当前行：历史表里只有**被取代的**版本，
          // 不并进来的话「我的预算变化过程」只能看到 5 万，看不到现在的 8 万，
          // 用户看到一条断尾的时间线，还会以为旧值仍然有效。
          timeline = current ? [current, ...archived] : archived;
        }

        if (timeline.length === 0) {
          return {
            ok: true,
            content: parsed.mode === "truth_as_of"
              ? `${parsed.asOf} 这个时刻没有任何生效中的版本（若该时点只有被修正的误记，它按定义从未生效，不会出现在这里）。`
              : "这项记忆没有历史版本记录。",
            data: { query: parsed.query, key, mode: parsed.mode, timeline: [] },
            metadata: {
              memoryHistoryMode: parsed.mode,
              memoryHistoryKey: key,
              memoryHistoryCount: 0,
            },
          };
        }

        const header = parsed.mode === "truth_as_of"
          ? `以下是 ${parsed.asOf} 这一时刻生效中的版本（已排除从未生效的误记）：`
          : "以下是系统先后记录过的版本（按停止采信时间倒序，含误记并已标注）：";
        return {
          ok: true,
          content: [
            header,
            renderTimeline(timeline),
            "这些内容是系统抽取的推断；时间区间和变更标注用于区分当前值、旧值与误记。不得向用户展示内部记忆键或来源枚举，标注为误记的条目不得作为历史事实陈述。",
          ].join("\n"),
          data: { query: parsed.query, key, mode: parsed.mode, timeline },
          metadata: {
            memoryHistoryMode: parsed.mode,
            memoryHistoryKey: key,
            memoryHistoryCount: timeline.length,
            memoryHistoryCorrectionCount: timeline.filter((item) => item.neverEffective).length,
            memoryHistoryKeyResolvedFrom: parsed.key ? "explicit_key" : "semantic_match",
          },
        };
      } catch (error) {
        return {
          ok: false,
          content: "查询记忆历史失败",
          error: error instanceof Error ? error.message : "Search memory history failed",
        };
      }
    },
  };
}

export const recallMemoryTool: ToolDefinition = createRecallMemoryTool();
export const searchMemoryHistoryTool: ToolDefinition = createSearchMemoryHistoryTool();
