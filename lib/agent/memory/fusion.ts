import type { MemoryRecord } from "./types";

/**
 * 向量通道与关键词通道的融合。
 *
 * 三个策略都要能跑，因为**赢家是要用数据定的，不是推理定的**：
 * eval/datasets/memory.ts 里的 fusion_ab 三条 case（vector_only / weighted / rrf）
 * 必须在真实库上各跑一遍。vector_only 是对照组：如果关键词通道的增量小于噪声，
 * 整个通道就不该留下——没有对照组，「融合有效」这个结论无法证伪。
 *
 * 当前用户配置默认 weighted，理由是记忆
 * 召回的候选池只有十几条、只取 top-3、条目极短，此时「0.92 相似」与「0.71 相似」
 * 的差别有意义，被 RRF 压成相邻序数是净损失（rrfK=60 时 rank 1 与 rank 10 只差 15%）。
 * 这是**待验证的默认值**，不是结论。
 *
 * ⚠️ 合并是**并集不是交集**。向量分高但关键词没命中的条目必须保留：
 * 关键词通道在中文常见词上本来就常常空手而归，取交集会把它的收益反向抵消掉。
 */

export type MemoryFusionStrategy = "vector_only" | "weighted" | "rrf";

export type MemoryFusionWeights = { vector: number; keyword: number };

/** 与 ragConfig 的 vectorWeight / keywordWeight 一致，便于两条链路对照调参。 */
export const DEFAULT_MEMORY_FUSION_WEIGHTS: MemoryFusionWeights = {
  vector: 0.7,
  keyword: 0.3,
};

/** 与 ragConfig.rrfK 一致。 */
export const DEFAULT_MEMORY_RRF_K = 60;

export type MemoryChannel = "vector" | "keyword";

export type FusedMemoryHit = {
  /** record.score 已被换成 fusedScore（排序用）。原始分看下面两个字段。 */
  record: MemoryRecord;
  /** 原始余弦相似度。0 表示没进向量通道的结果，不表示「完全不相似」。 */
  vectorScore: number;
  /** 原始 keyword_rank。0 表示关键词通道没命中。 */
  keywordScore: number;
  fusedScore: number;
  channels: MemoryChannel[];
};

function clamp01(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * 原始分与排名百分位的混合，公式照抄 lib/knowledge/retriever.ts:798 的
 * calibrateListScore。
 *
 * 为什么是复制而不是 import：那个函数是 retriever 的模块内私有函数，其所在模块
 * 加载时会拉起整条 RAG 配置链路（ragConfig / embedding / supabase），记忆召回不该
 * 为一个 3 行的算术函数背上这些依赖。复制的代价是两处要一起改——所以留下这条注释。
 *
 * 为什么不自己写个更简单的 1/(1+rank)：那样只剩相对位置，丢掉「多像」。
 * 记忆场景两个信息都需要：候选池小，排名粒度粗（十几条时百分位一档就跳 7%），
 * 光靠排名不足以区分 0.92 与 0.71。
 */
export function calibrateMemoryListScore(
  rawScore: unknown,
  rank: number,
  listLength: number,
) {
  const rankPercentile = listLength <= 1 ? 1 : 1 - (rank - 1) / (listLength - 1);
  return clamp01(clamp01(rawScore) * 0.7 + rankPercentile * 0.3);
}

export function fuseMemoryChannels(input: {
  /** 向量通道结果，已按相似度降序。record.score = 相似度。 */
  vector: MemoryRecord[];
  /** 关键词通道结果，已按 keyword_rank 降序。record.score = keyword_rank。 */
  keyword: MemoryRecord[];
  strategy: MemoryFusionStrategy;
  weights?: MemoryFusionWeights;
  rrfK?: number;
}): FusedMemoryHit[] {
  const weights = input.weights ?? DEFAULT_MEMORY_FUSION_WEIGHTS;
  const rrfK = input.rrfK ?? DEFAULT_MEMORY_RRF_K;
  // vector_only 是对照组：连关键词结果都不看，避免「对照组其实偷偷用了另一路」。
  const keywordList = input.strategy === "vector_only" ? [] : input.keyword;

  type Accumulator = {
    record: MemoryRecord;
    vectorRaw: number;
    keywordRaw: number;
    vectorCalibrated: number;
    keywordCalibrated: number;
    rrfRaw: number;
    channels: Set<MemoryChannel>;
  };
  const accumulators = new Map<string, Accumulator>();

  const ingest = (
    records: MemoryRecord[],
    channel: MemoryChannel,
    weight: number,
  ) => {
    records.forEach((record, index) => {
      const rank = index + 1;
      const raw = clamp01(record.score);
      const current = accumulators.get(record.key) ?? {
        record,
        vectorRaw: 0,
        keywordRaw: 0,
        vectorCalibrated: 0,
        keywordCalibrated: 0,
        rrfRaw: 0,
        channels: new Set<MemoryChannel>(),
      };
      // 同义词和普通中文词只负责把记录带进候选池。应用层重算后的 raw=0
      // 必须保持 0，不能再被排名百分位凭空抬成一个可参与最终排序的关键词分。
      const calibrated = raw > 0
        ? calibrateMemoryListScore(raw, rank, records.length)
        : 0;
      if (channel === "vector") {
        current.vectorRaw = Math.max(current.vectorRaw, raw);
        current.vectorCalibrated = Math.max(current.vectorCalibrated, calibrated);
      } else {
        current.keywordRaw = Math.max(current.keywordRaw, raw);
        current.keywordCalibrated = Math.max(current.keywordCalibrated, calibrated);
      }
      current.rrfRaw += weight / (rrfK + rank);
      current.channels.add(channel);
      accumulators.set(record.key, current);
    });
  };

  const activeWeights = [
    { records: input.vector, channel: "vector" as const, weight: weights.vector },
    { records: keywordList, channel: "keyword" as const, weight: weights.keyword },
  ].filter((list) => list.weight > 0 && list.records.length > 0);

  for (const list of activeWeights) {
    ingest(list.records, list.channel, list.weight);
  }
  // 归一化基准：每条通道都排第 1 时的理论最大值。不除的话 RRF 分数是 0.01 量级，
  // 与 selectThreshold 那套 0~1 的量纲完全不可比。
  const maxRrf = activeWeights.reduce((sum, list) => sum + list.weight / (rrfK + 1), 0);

  return Array.from(accumulators.values()).map((current) => {
    const fusedScore = input.strategy === "vector_only"
      ? current.vectorRaw
      : input.strategy === "rrf"
        ? (maxRrf > 0 ? clamp01(current.rrfRaw / maxRrf) : 0)
        : clamp01(
            current.vectorCalibrated * weights.vector
              + current.keywordCalibrated * weights.keyword,
          );
    return {
      // score 换成融合分：下游 rankMemoryHits 按 score 排序，必须拿到融合后的值。
      record: { ...current.record, score: fusedScore },
      vectorScore: current.vectorRaw,
      keywordScore: current.keywordRaw,
      fusedScore,
      channels: Array.from(current.channels),
    };
  });
}

/**
 * 准入判定：**按通道原始分判，不按融合分判**。
 *
 * 这一步很容易写错，错法是「融合分 >= threshold」。以 weighted 为例，关键词没命中
 * 时融合分约为 0.7 × 校准向量分，一条相似度 0.75 的记忆融合后掉到 0.5 出头，
 * 低于 0.68 的阈值被丢掉——**开启融合等于顺手抬高了召回门槛**，而且没有任何测试
 * 会失败，只是记忆悄悄变少了。
 *
 * 所以两件事分开：
 *   - 准入看原始分（向量分过阈值，或关键词分足够高把低向量分的条目救回来）
 *   - 排序看融合分（两个通道都命中的条目排到前面，这才是融合的收益所在）
 */
export function admitFusedMemories(
  hits: FusedMemoryHit[],
  options: {
    /** 向量通道的严过滤阈值，等于配置里的 threshold。 */
    selectThreshold: number;
    /**
     * 关键词通道的准入线。设得比向量阈值低没有意义——keyword_rank 是
     * 「命中词数 / 总词数」，与余弦相似度不同量纲：0.5 已经表示一半的关键词
     * 逐字出现在这条记忆里，对短记忆来说是很强的信号。
     */
    keywordAdmitThreshold: number;
  },
): FusedMemoryHit[] {
  return hits.filter(
    (hit) =>
      hit.vectorScore >= options.selectThreshold
      || hit.keywordScore >= options.keywordAdmitThreshold,
  );
}
