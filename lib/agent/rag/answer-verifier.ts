import { mergeEvidenceBundles } from "./evidence";
import type {
  ClaimEvidenceCheck,
  EvidenceBundle,
  GroundednessReport,
} from "./types";

// 回答中的引用必须严格写成 [ev_十二位十六进制]。捕获组只返回 evidenceId
// 本身，外层方括号不参与后续 Map 查询。这里的格式必须与 evidence.ts 中的
// evidenceId() 保持一致；格式不匹配的文本不会被当作引用。
const CITATION_PATTERN = /\[(ev_[a-f0-9]{12})\]/g;

// 一条引用要覆盖一个 claim（无论是自身引用还是同节继承），claim 与证据正文的
// 词面重合度至少要到这条线。0.08 很低，因为 tokenize 用的是中文二元字组，
// 同主题不同表述的句子重合度通常也只有 0.1~0.3。
const MIN_LEXICAL_SUPPORT = 0.08;

/**
 * 对最终回答做 claim 级引用校验，并生成可写入 Trace 的结构化报告。
 *
 * 这里校验的是三个逐级收紧的问题：
 * 1. coverage：回答中的事实句有没有附引用；
 * 2. precision：写出的引用是否存在，并与对应句子有最低词面重合；
 * 3. groundedness：事实句能否被至少一条已知引用提供最低词面支持。
 *
 * 这不是语义蕴含或事实真伪模型。lexicalOverlap 只能发现“句子和证据使用了
 * 一些相同词”，不能证明证据真的支持结论，尤其不能识别否定、数值矛盾和
 * 复杂推理。它的定位是低成本、可复现的观测指标，而不是事实核验器或输出门禁。
 *
 * claim 的粒度必须和 EVIDENCE_CITATION_POLICY 教给模型的引用习惯一致，否则
 * 一个完全有据可依的回答也会被判不合格：模型按语义单元在主句上写引用，随后
 * 展开的细节句不再重复引用。所以这里做两件事 —— 把标题、流程图、标签行等
 * 结构文本排除出计分分母（见 splitClaims），并允许同一节内的 claim 继承该节
 * 已引用证据的支持（见下方 scope 逻辑）。继承仍要求达到最低词面支持线，
 * 因此“旁边有引用”不能让一句无关的断言蒙混过关。
 */
export function verifyGroundedAnswer(
  answer: string,
  bundles: EvidenceBundle[],
  options: { evidenceRequired?: boolean } = {},
): GroundednessReport {
  // 一个 Agent run 可能产生多个 EvidenceBundle，同一证据也可能跨 bundle 重复。
  // 先按 evidenceId 合并去重，再建立 O(1) 查询表，供每条 claim 校验引用真伪。
  const evidences = mergeEvidenceBundles(bundles);
  const evidenceById = new Map(evidences.map((item) => [item.evidenceId, item]));

  // claim 是本校验器的最小计分单位，通常是一句话。引用必须保留在它所支撑的
  // claim 中，否则后续无法判断这条引用具体支持哪一句话。
  const claims = splitClaims(answer);
  const direct = claims.map(({ text: claim, scope }) => {
    // 提取模型实际写出的引用，并区分“本轮真实证据”和模型编造/过期的 ID。
    const citationIds = Array.from(claim.matchAll(CITATION_PATTERN), (match) => match[1]);
    const unknownCitationIds = citationIds.filter((id) => !evidenceById.has(id));
    const knownEvidence = citationIds.flatMap((id) => {
      const evidence = evidenceById.get(id);
      return evidence ? [evidence] : [];
    });

    // 一句话可以引用多条证据。这里取最高重合度，含义是“至少有一条引用能
    // 支持这句话”即可；不是要求所有引用都支持。每条引用是否有效会在下面的
    // citationPrecision 计算中分别检查。
    const lexicalSupport = knownEvidence.length === 0
      ? 0
      : Math.max(...knownEvidence.map((item) => lexicalOverlap(claim, `${item.title} ${item.content}`)));
    return {
      claim,
      scope,
      citationIds,
      unknownCitationIds,
      // 必须同时满足：有真实引用、没有未知 ID、且至少一条证据达到支持线。
      supported: knownEvidence.length > 0
        && unknownCitationIds.length === 0
        && lexicalSupport >= MIN_LEXICAL_SUPPORT,
      lexicalSupport,
    };
  });

  // 收集每一节内被有效引用过的证据，供该节其余 claim 继承。编造的 ID 不进入
  // 继承池 —— 一个引用了不存在证据的段落不应该反过来为整段背书。
  const scopeEvidence = new Map<number, string[]>();
  for (const check of direct) {
    if (check.unknownCitationIds.length > 0) continue;
    const known = check.citationIds.filter((id) => evidenceById.has(id));
    if (known.length === 0) continue;
    scopeEvidence.set(check.scope, (scopeEvidence.get(check.scope) ?? []).concat(known));
  }

  const checks: ClaimEvidenceCheck[] = direct.map((check) => {
    if (check.citationIds.length > 0) return { ...check, inherited: false };
    // 自身没写引用时，看本节已引用的证据里有没有一条能在词面上支撑这句话。
    // 这既还原了模型“一节引一次”的写法，又保留了对无关断言的拦截能力。
    const candidates = scopeEvidence.get(check.scope) ?? [];
    let best = 0;
    for (const id of candidates) {
      const evidence = evidenceById.get(id);
      if (!evidence) continue;
      best = Math.max(best, lexicalOverlap(check.claim, `${evidence.title} ${evidence.content}`));
    }
    const inherited = best >= MIN_LEXICAL_SUPPORT;
    return { ...check, inherited, supported: inherited, lexicalSupport: best };
  });

  // precision 按“引用次数”计分，而不是按 claim 计分。若一句话写了三条引用，
  // 其中只有两条与句子达到最低重合度，则这一句贡献 2/3 的引用准确率。
  const citationCount = checks.reduce((sum, check) => sum + check.citationIds.length, 0);
  const supportedCitationCount = checks.reduce((sum, check) => {
    const claimWithoutCitations = check.claim.replace(CITATION_PATTERN, "");
    return sum + check.citationIds.filter((id) => {
      const evidence = evidenceById.get(id);
      return evidence
        ? lexicalOverlap(claimWithoutCitations, `${evidence.title} ${evidence.content}`)
          >= MIN_LEXICAL_SUPPORT
        : false;
    }).length;
  }, 0);

  // coverage 关心 claim 是否有引用可依（自身写的或同节继承的），groundedness
  // 要求这条引用真实存在并达到最低词面支持线；precision 只按模型实际写出的
  // 引用计分，不受继承影响 —— 编造引用的代价始终由 precision 承担。
  const citedClaimCount = checks.filter((check) => check.citationIds.length > 0).length;
  const coveredClaimCount = checks.filter((check) =>
    check.citationIds.length > 0 || check.inherited).length;
  const supportedClaimCount = checks.filter((check) => check.supported).length;
  const citationPrecision = citationCount > 0 ? supportedCitationCount / citationCount : 0;
  const citationCoverage = checks.length > 0 ? coveredClaimCount / checks.length : 1;
  const groundedness = checks.length > 0 ? supportedClaimCount / checks.length : 1;

  // 报告只保留去重后的未知 ID，便于 Trace/UI 直接展示模型编造了哪些引用。
  const unknownCitationIds = Array.from(new Set(checks.flatMap((check) => check.unknownCitationIds)));
  const evidenceRequired = options.evidenceRequired === true;

  // 状态按严重程度判定：
  // - 没有证据：只有本轮明确要求证据时才 fail，软检索场景允许直接回答；
  // - fail：存在未知引用，或 groundedness/precision 低于 50%；
  // - warn：没有硬失败，但 coverage 低于 80%，或 groundedness/precision 低于 75%/80%；
  // - pass：以上指标全部达到放行线。
  const status = evidences.length === 0
    ? evidenceRequired ? "fail" : "pass"
    : unknownCitationIds.length > 0 || groundedness < 0.5 || citationPrecision < 0.5
      ? "fail"
      : citationCoverage < 0.8 || groundedness < 0.75 || citationPrecision < 0.8
        ? "warn"
        : "pass";

  return {
    status,
    evidenceRequired,
    evidenceCount: evidences.length,
    claimCount: checks.length,
    citedClaimCount,
    coveredClaimCount,
    supportedClaimCount,
    citationPrecision,
    citationCoverage,
    groundedness,
    unknownCitationIds,
    checks,
  };
}

// 章节分隔符：markdown 标题、中文序号标题、整行加粗小标题。命中的行本身不
// 计分，只把后续 claim 归入新的作用域。
const HEADING_PATTERN =
  /^(?:#{1,6}\s|\*{2}[^*]+\*{2}[:：]?$|(?:第?[一二三四五六七八九十百]{1,3}[、．.]|\d{1,2}[、．.)])\s*\S)/;
// 句末标点。结构性文本（标题、流程图、层级树、标签行）几乎不会以它结尾，
// 这是把它们排除出计分分母的判据。
const SENTENCE_END = /[。！？；!?;.]$/;
// 流程图、层级树、表格等图示行；即使误带了句末标点也不当作事实句。
const DIAGRAM_PATTERN = /[→←↔⇒├└│┌┐]|-->|\|\s*[-:]+\s*\|/;
// 常见来源、注意事项等元信息区块不参与评分，避免把展示性文本误判成 claim。
const META_PATTERN = /^(?:证据校验|来源|参考|注意|说明)[:：]/;
// CITATION_PATTERN 带 /g，用 test() 会推进 lastIndex，这里单独用无状态副本。
const HAS_CITATION = /\[ev_[a-f0-9]{12}\]/;

/**
 * 把回答切成计分用的 claim，并标注每个 claim 所属的章节序号。
 *
 * 只有“看起来在陈述事实”的片段进入分母：有句末标点，或者自己带了引用。
 * 标题、`想 → 做 → 看结果` 这类流程图、`基础层：LLM 对话` 这类标签行会被
 * 排除 —— 它们是排版结构，不存在该不该引用的问题，留在分母里只会让结构化
 * 程度更高的回答拿到更低的覆盖率。
 */
function splitClaims(answer: string) {
  const claims: { text: string; scope: number }[] = [];
  let scope = 0;
  for (const rawLine of answer.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (HEADING_PATTERN.test(line) && !SENTENCE_END.test(line)) {
      scope += 1;
      continue;
    }
    // 在中英文句末标点处分句。若标点后紧跟 [ev_...]，负向前瞻阻止此处切分，
    // 使“事实句。[引用]”仍是同一个 claim，而不是把引用拆成孤立句。
    for (const piece of line.split(/(?<=[。！？!?；;])(?!(?:\s*\[ev_[a-f0-9]{12}\]))/)) {
      const text = piece.trim();
      if (text.length < 8) continue;
      if (META_PATTERN.test(text)) continue;
      if (!HAS_CITATION.test(text)
        && (!SENTENCE_END.test(text) || DIAGRAM_PATTERN.test(text))) continue;
      claims.push({ text, scope });
    }
  }
  return claims;
}

function lexicalOverlap(claim: string, evidence: string) {
  // 这是以 claim 词项为分母的单向覆盖率：claim 中有多少词项也出现在证据里。
  // 因此长证据不会仅因包含大量无关词而被额外惩罚。
  const claimTerms = tokenize(claim.replace(CITATION_PATTERN, ""));
  if (claimTerms.size === 0) return 0;
  const evidenceTerms = tokenize(evidence);
  let hits = 0;
  for (const term of Array.from(claimTerms)) {
    if (evidenceTerms.has(term)) hits++;
  }
  return hits / claimTerms.size;
}

function tokenize(text: string) {
  const terms = new Set<string>();
  // 英文、数字、URL 片段按连续 token 保留；中文先匹配连续片段，再对长度超过
  // 3 的片段生成二元字组。例如“检索证据”会产生“检索/索证/证据”，从而在
  // 没有分词库的情况下获得一个便宜、确定且可复现的中文重合度近似值。
  for (const token of text.toLowerCase().match(/[a-z0-9_\-./]{2,}|[\u4e00-\u9fff]{2,8}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length > 3) {
      for (let index = 0; index <= token.length - 2; index++) terms.add(token.slice(index, index + 2));
    } else {
      terms.add(token);
    }
  }
  return terms;
}
