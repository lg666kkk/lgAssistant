import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import type { MemoryType } from "./types";

/**
 * 历史表保留期清理（文档 4.5 / item 16）。
 *
 * ⚠️ 先划清与 purge_memory 的分工，这两件事不能互相替代：
 *   - 本模块：「时间到了自动清」。运维动作，跨用户扫描，按 memory_type 分档。
 *   - purge_memory：「用户现在要求彻底抹掉」。隐私合规动作，指定 user_id + key，
 *     三张表同事务硬删，与时间无关。
 * 把保留期当成删除能力（「反正 90 天后会自动删」）是隐私事故；把硬删除当成保留期
 * （逐个 key 手删）是运维不可行。
 *
 * 分档理由：历史行的价值随时间衰减的速度按类型差很多。
 *   - profile（居住地、职业）：变化以年计，一条旧值放两年仍然能解释「什么时候搬的」。
 *   - fact（预算、型号）：变化以月计，一年前的预算对今天的对话没有解释力。
 *   - preference / project：介于两者之间，按 fact 处理。
 *   - correction（系统曾记错）：按 profile 一档留最久。用户问「你之前是不是把我的
 *     预算记错了」时，能回答的只有这类行；删早了等于系统抹掉了自己的错误记录。
 *   - episodic（某次具体事件）：本来就是流水，过期最快。
 *
 * ⚠️ 清理是**有损的**，而且损在 search_memory_history 的 truth_as_of 模式上：
 * 行被删掉之后，问「我去年这时候预算多少」会得到「那时没有任何记录」，
 * 而正确答案是「记录已过保留期」。这两者在工具返回值里目前**不可区分** ——
 * 这是保留期这个决定本身的代价，不是 bug。所以默认保留期取得偏长（fact 一年），
 * 缩短之前先想清楚会答错哪些问题。
 *
 * 为什么这里不要 userId：这是唯一一处**故意跨用户**的记忆表访问。因此它
 *   1. 只从脚本入口调用（scripts/memory-history-cleanup.ts），
 *   2. **不得**被任何工具或 agent 链路引用 —— 模型永远拿不到跨用户的删除能力。
 */

/** 各类型的默认保留天数。可用环境变量逐档覆盖。 */
export const DEFAULT_HISTORY_RETENTION_DAYS: Record<MemoryType | "default", number> = {
  profile: 730,
  correction: 730,
  fact: 365,
  preference: 365,
  project: 365,
  episodic: 90,
  // 未知类型走这一档：新增 memory_type 时宁可留久，不要静默删得更狠。
  default: 730,
};

const RETENTION_ENV: Record<string, string> = {
  profile: "MEMORY_HISTORY_RETENTION_DAYS_PROFILE",
  correction: "MEMORY_HISTORY_RETENTION_DAYS_CORRECTION",
  fact: "MEMORY_HISTORY_RETENTION_DAYS_FACT",
  preference: "MEMORY_HISTORY_RETENTION_DAYS_PREFERENCE",
  project: "MEMORY_HISTORY_RETENTION_DAYS_PROJECT",
  episodic: "MEMORY_HISTORY_RETENTION_DAYS_EPISODIC",
  default: "MEMORY_HISTORY_RETENTION_DAYS_DEFAULT",
};

export type HistoryRetentionTier = {
  memoryType: string;
  retentionDays: number;
  cutoff: string;
};

export type HistoryCleanupTierResult = HistoryRetentionTier & {
  /** dryRun 时是「将被删除」，否则是「已删除」。 */
  rows: number;
};

export type HistoryCleanupResult = {
  dryRun: boolean;
  scannedTiers: number;
  deletedRows: number;
  tiers: HistoryCleanupTierResult[];
  /** 保留期之外仍被保留的行数（分档命中不到的类型走 default 档，不会漏）。 */
  remainingRows: number | null;
};

function readRetentionDays(tier: string, fallback: number) {
  const raw = Number(process.env[RETENTION_ENV[tier]]);
  // 0 或负数不接受：那等于「立即删光」，绝不能靠一个写错的环境变量触发。
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function resolveRetentionTiers(now = Date.now()): HistoryRetentionTier[] {
  return Object.entries(DEFAULT_HISTORY_RETENTION_DAYS).map(([memoryType, fallback]) => {
    const retentionDays = readRetentionDays(memoryType, fallback);
    return {
      memoryType,
      retentionDays,
      cutoff: new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    };
  });
}

/**
 * 按 superseded_at（记录轴的归档时刻）判断过期，不按 effective_to（有效轴）。
 *
 * 用 effective_to 会删错一类行：correction 归档的行 effective_to == effective_from，
 * 可能是很久以前的时间点，但它是**刚刚**才被记为误记的 —— 恰恰是最该留着的行
 *（用户问「你之前是不是记错了」靠的就是它）。归档时刻才是「这条信息在系统里躺了多久」。
 */
export async function cleanupMemoryHistory(
  input: { dryRun?: boolean; now?: number } = {},
): Promise<HistoryCleanupResult> {
  const dryRun = input.dryRun ?? false;
  const tiers = resolveRetentionTiers(input.now ?? Date.now());
  const empty: HistoryCleanupResult = {
    dryRun,
    scannedTiers: 0,
    deletedRows: 0,
    tiers: [],
    remainingRows: null,
  };
  if (!hasSupabaseConfig()) {
    console.warn("[cleanupMemoryHistory] 缺少 Supabase 配置，跳过清理");
    return empty;
  }

  const supabase = getSupabase();
  const knownTypes = tiers
    .filter((tier) => tier.memoryType !== "default")
    .map((tier) => tier.memoryType);
  const results: HistoryCleanupTierResult[] = [];

  for (const tier of tiers) {
    // default 档兜住所有未列举的类型（含将来新增的），用 not-in 而不是等值匹配。
    const scope = (query: any) =>
      tier.memoryType === "default"
        ? query.not("memory_type", "in", `(${knownTypes.join(",")})`)
        : query.eq("memory_type", tier.memoryType);

    if (dryRun) {
      const { count, error } = await scope(
        supabase
          .from("agent_memory_history")
          .select("id", { count: "exact", head: true })
          .lt("superseded_at", tier.cutoff),
      );
      if (error) throw new Error(`[cleanupMemoryHistory] 预估失败: ${error.message}`);
      results.push({ ...tier, rows: count ?? 0 });
      continue;
    }

    // .select("id") 让 DELETE 回传被删的行，这是唯一可靠的删除条数来源；
    // 少了它只能靠「删之前 count 一次」，两次查询之间可能有新归档进来。
    const { data, error } = await scope(
      supabase.from("agent_memory_history").delete().lt("superseded_at", tier.cutoff),
    ).select("id");
    if (error) throw new Error(`[cleanupMemoryHistory] 清理失败: ${error.message}`);
    results.push({ ...tier, rows: data?.length ?? 0 });
  }

  const { count: remainingRows } = await supabase
    .from("agent_memory_history")
    .select("id", { count: "exact", head: true });

  return {
    dryRun,
    scannedTiers: results.length,
    deletedRows: results.reduce((sum, tier) => sum + tier.rows, 0),
    tiers: results,
    remainingRows: remainingRows ?? null,
  };
}
