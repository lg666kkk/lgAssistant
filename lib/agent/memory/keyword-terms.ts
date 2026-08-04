import { CONTROLLED_MEMORY_KEYS, isControlledMemoryKey } from "./controlled-keys";

/**
 * 把用户的提问切成关键词通道要用的 term 数组。
 *
 * 为什么切词放在应用层而不是 SQL：SQL 那边能用的切词手段只有
 * `regexp_split_to_table(query, '\s+')`（按空格）与 `to_tsvector('simple')`，
 * 两者对中文都是整句一个 token —— 于是「关键词命中」退化成「原文必须一字不差
 * 出现整句话」，实际永不命中。Node 内置 Intl.Segmenter 能切中文且零依赖，
 * 所以 SQL 只负责子串匹配与计分，切词由这里做。
 *
 * 四类 term，按「是否需要分词」排序，收益大头恰好都不需要分词：
 *   1. 数字        —— 向量对数字几乎完全不敏感（「8 万」与「5 万」的余弦距离
 *                     小到可忽略），这类是关键词通道最主要的收益来源。
 *   2. Latin 词    —— 型号、专名（Model Y / iPhone）。
 *   3. 受控 key    —— 字面量或中文标签，翻成 key 走等值匹配。
 *   4. 中文词      —— Intl.Segmenter 切分 + 停用词过滤。
 */

export type MemoryQueryTerms = {
  /** 与 content 做子串匹配的词。 */
  terms: string[];
  /** 与 key 列做等值匹配的受控 key。 */
  keys: string[];
};

/**
 * 停用词表是**必需的，不是优化**。
 *
 * 没有它，「我」「的」「是」「多少」会命中几乎每一条记忆，overlap_rank 全是高分，
 * 关键词通道从「区分信号」变成「噪声发生器」——比不做这个通道更糟，因为它会把
 * 无关记忆的融合分抬到与相关记忆同一档。
 *
 * 只收「几乎不携带槽位信息」的词。刻意**不**收 预算 / 过敏 / 城市 这类词：
 * 它们出现频率高，但正是用来区分槽位的。
 */
export const MEMORY_STOPWORDS = new Set([
  // 人称与指代
  "我", "我的", "你", "你的", "他", "她", "它", "我们", "自己", "用户",
  "这", "那", "这个", "那个", "这些", "那些", "这样", "那样", "这条", "那条",
  // 虚词
  "的", "了", "着", "过", "得", "地", "和", "与", "或", "把", "被", "给",
  "在", "从", "到", "对", "跟", "为", "由", "让", "是", "有", "没有", "不是",
  "也", "都", "就", "还", "又", "很", "太", "更", "最", "比较", "特别",
  // 连词。Segmenter 会把「还是」「或者」切成整词，逐字停用词拦不住它们。
  "还是", "或者", "以及", "而且", "但是", "因为", "所以", "如果", "然后",
  // 疑问与句末
  "吗", "呢", "吧", "啊", "多少", "什么", "怎么", "怎样", "哪", "哪个",
  "哪里", "哪儿", "为什么", "是不是", "有没有", "几", "几个",
  // 时间指代（入口正则靠它们判断「在问过去」，但它们不指向任何槽位）
  "之前", "以前", "上次", "当初", "原来", "现在", "目前", "已经", "后来",
  // 高频动词与礼貌用语
  "请", "帮", "帮我", "一下", "可以", "能", "会", "想", "要", "需要", "应该",
  "知道", "告诉", "说", "问", "看", "记得", "记住", "推荐", "建议",
  // Latin 侧
  "the", "a", "an", "of", "is", "are", "was", "were", "be", "to", "in", "on",
  "at", "for", "and", "or", "my", "me", "i", "you", "it", "do", "does", "did",
  "what", "which", "how", "why", "when", "where", "can", "could", "should",
  "would", "please", "tell", "about",
]);

/**
 * term 总数上限。
 *
 * 不只是为了省 CPU：overlap_rank = 命中数 / term 总数，term 越多分母越大，
 * 一句长提问会把真正相关那条记忆的分数摊薄到接近 0。截断保住区分度。
 */
const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 2;

const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;
// 允许型号里的连字符与点（iPhone 15 Pro / gpt-4.1 / node.js）。
const LATIN_PATTERN = /[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g;
const CONTROLLED_KEY_PATTERN = /[a-z][a-z0-9_]*(?::[a-z0-9_]+)+/g;
const CJK_PATTERN = /[㐀-䶿一-鿿]/;

/**
 * 受控 key 的中文标签 → key。
 *
 * 用户不会说「budget:car」，会说「购车预算」。把标签翻回 key 之后走 key 等值匹配，
 * 这是本通道里最可信的一路：同一槽位的记忆一定挂在同一个受控 key 上（这正是
 * controlled-keys.ts 存在的理由），所以标签命中等于槽位命中，不存在歧义。
 *
 * 标签里的括号补充说明（「饮食偏好（喜欢吃什么）」）要去掉——用户说的是前半截。
 */
const CONTROLLED_LABEL_TO_KEY = new Map<string, string>(
  Object.entries(CONTROLLED_MEMORY_KEYS).map(([key, meta]) => [
    meta.label.replace(/（.*$/, "").trim(),
    key,
  ]),
);

let segmenter: Intl.Segmenter | null | undefined;

/**
 * Intl.Segmenter 在 Node 18+ 与所有现代浏览器上都有，但仍然做能力检测：
 * 拿不到时中文那一路静默降级（回到「只有数字/Latin/受控 key」的第一步形态），
 * 而不是让整个召回链路抛异常。降级的后果是中文专名召不回，不是召回错的。
 */
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = typeof Intl?.Segmenter === "function"
      ? new Intl.Segmenter("zh-CN", { granularity: "word" })
      : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

function pushTerm(collected: Set<string>, raw: string) {
  const term = raw.trim().toLowerCase();
  if (!term || MEMORY_STOPWORDS.has(term)) return;
  // 数字单字符要留（「8w」里的 8 是关键信息），文字单字符不留（噪声太大）。
  if (term.length < MIN_TERM_LENGTH && !/^\d$/.test(term)) return;
  collected.add(term);
}

export function extractMemoryQueryTerms(query: string): MemoryQueryTerms {
  const text = query.trim();
  if (!text) return { terms: [], keys: [] };

  const terms = new Set<string>();
  const keys = new Set<string>();

  // ① 受控 key 字面量。先做：命中它就等于拿到了槽位，最可信的一路。
  for (const match of Array.from(text.toLowerCase().matchAll(CONTROLLED_KEY_PATTERN))) {
    if (isControlledMemoryKey(match[0])) keys.add(match[0]);
  }
  // ② 受控 key 的中文标签。
  CONTROLLED_LABEL_TO_KEY.forEach((key, label) => {
    if (label.length >= MIN_TERM_LENGTH && text.includes(label)) keys.add(key);
  });

  // ③ 数字。只抽裸数字，不带单位：记忆里写的是「8 万」（中间有空格）、
  //    用户问的是「8w」，把单位粘上去两边都对不上；裸 8 能同时命中两种写法。
  //    代价是「8」也会命中「18 万」——这是打分通道不是过滤通道，误命中只让
  //    无关记忆多一点分，真正相关的那条会命中更多 term 而排在前面。
  for (const match of Array.from(text.matchAll(NUMBER_PATTERN))) {
    pushTerm(terms, match[0]);
  }

  // ④ Latin 词。
  for (const match of Array.from(text.matchAll(LATIN_PATTERN))) {
    pushTerm(terms, match[0]);
  }

  // ⑤ 中文词。
  const wordSegmenter = getSegmenter();
  if (wordSegmenter && CJK_PATTERN.test(text)) {
    for (const segment of Array.from(wordSegmenter.segment(text))) {
      if (!segment.isWordLike) continue;
      if (!CJK_PATTERN.test(segment.segment)) continue;
      pushTerm(terms, segment.segment);
    }
  }

  return {
    terms: Array.from(terms).slice(0, MAX_TERMS),
    keys: Array.from(keys),
  };
}
