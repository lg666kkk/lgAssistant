import { describe, expect, it } from "vitest";
import {
  MEMORY_STOPWORDS,
  extractMemoryQueryTerms,
  scoreMemoryKeywordMatch,
} from "./keyword-terms";

/**
 * 这组断言盯的是关键词通道最容易悄悄失效的三处：
 *   1. 停用词真的被丢掉了 —— 漏一个高频虚词，overlap_rank 全是高分，
 *      通道从「区分信号」变成「噪声发生器」。
 *   2. 数字被单独抽出来 —— 这是整个通道最主要的收益来源（向量分不开 8 万与 5 万）。
 *   3. term 数量有上限 —— overlap_rank 的分母是 term 总数，长提问会把真正相关
 *      那条记忆的分数摊薄到接近 0。
 */

describe("extractMemoryQueryTerms", () => {
  it("把受控 key 的中文标签翻回 key，虚词一个都不留", () => {
    const { terms, keys } = extractMemoryQueryTerms("我之前购车预算是多少");

    expect(keys).toEqual(["budget:car"]);
    expect(terms).toContain("预算");
    // 「我」「之前」「是」「多少」全在停用词表里；「购」「车」是单字噪声。
    for (const noise of ["我", "之前", "是", "多少", "购", "车"]) {
      expect(terms).not.toContain(noise);
    }
  });

  it("购车预算与购车首付预算是两个槽位，标签不会互相误命中", () => {
    expect(extractMemoryQueryTerms("购车首付预算是多少").keys).toEqual([
      "budget:car:down_payment",
    ]);
    expect(extractMemoryQueryTerms("购车预算是多少").keys).toEqual(["budget:car"]);
  });

  it("受控 key 字面量直接识别", () => {
    const { keys } = extractMemoryQueryTerms("查一下 diet:allergy 这条记忆");
    expect(keys).toEqual(["diet:allergy"]);
  });

  it("不存在的 key 形状的字符串不会被当成受控 key", () => {
    expect(extractMemoryQueryTerms("看看 foo:bar 是什么").keys).toEqual([]);
  });

  it("裸数字被抽成独立 term —— 通道存在的首要理由", () => {
    const { terms } = extractMemoryQueryTerms("我预算是 8w 还是 5w");

    // 不带单位：记忆里写「8 万」、用户问「8w」，粘上单位两边都对不上。
    expect(terms).toContain("8");
    expect(terms).toContain("5");
    // 「还是」是连词，不能进 term，否则它会命中大量记忆。
    expect(terms).not.toContain("还是");
  });

  it("小数不会被切成两段", () => {
    expect(extractMemoryQueryTerms("月供 3.5 万能接受吗").terms).toContain("3.5");
  });

  it("Latin 专名与型号保留，单字母不留", () => {
    const { terms } = extractMemoryQueryTerms("帮我看看 Model Y 值不值得买");

    expect(terms).toContain("model");
    expect(terms).not.toContain("y");
  });

  it("带连字符和点的型号是一个整体 term", () => {
    const { terms } = extractMemoryQueryTerms("我之前用的是 gpt-4.1 还是 node.js");
    expect(terms).toContain("gpt-4.1");
    expect(terms).toContain("node.js");
  });

  it("term 数量截到上限，避免摊薄 overlap_rank 的分母", () => {
    const query = Array.from({ length: 30 }, (_, i) => `型号${i} abc${i} ${i}00`).join(" ");
    expect(extractMemoryQueryTerms(query).terms.length).toBeLessThanOrEqual(12);
  });

  it("空查询返回空结果，不让 SQL 去算 0/0", () => {
    expect(extractMemoryQueryTerms("   ")).toEqual({
      terms: [],
      keys: [],
      strongTerms: [],
    });
  });

  it("同义表达只扩大候选，不直接产生最终关键词分", () => {
    const input = extractMemoryQueryTerms("我不喜欢或者讨厌吃什么呢");

    expect(input.terms).toEqual(expect.arrayContaining([
      "不喜欢",
      "讨厌",
      "不吃",
      "忌口",
    ]));
    expect(input.strongTerms).toEqual([]);
    expect(scoreMemoryKeywordMatch("用户讨厌吃折耳根", "diet:food:折耳根", input)).toBe(0);
    expect(scoreMemoryKeywordMatch("用户不吃香菜", "diet:food:香菜", input)).toBe(0);
    expect(scoreMemoryKeywordMatch("用户喜欢吃土豆", "diet:food:土豆", input)).toBe(0);
  });

  it("数字、型号和精确 key 保留为强关键词评分信号", () => {
    const numeric = extractMemoryQueryTerms("预算是 8w");
    const model = extractMemoryQueryTerms("我用的是 gpt-4.1");
    const exactKey = extractMemoryQueryTerms("查 diet:allergy");

    expect(scoreMemoryKeywordMatch("用户预算 8 万", "budget:car", numeric)).toBe(1);
    expect(scoreMemoryKeywordMatch("用户使用 gpt-4.1", "tech:model", model)).toBe(1);
    expect(scoreMemoryKeywordMatch("任意正文", "diet:allergy", exactKey)).toBe(1);
  });

  it("停用词表刻意不收槽位词：预算 / 过敏 / 城市 必须能进 term", () => {
    // 收了它们，关键词通道就再也分不出「问的是哪个槽位」。
    for (const slotWord of ["预算", "过敏", "城市", "首付"]) {
      expect(MEMORY_STOPWORDS.has(slotWord)).toBe(false);
    }
  });
});
