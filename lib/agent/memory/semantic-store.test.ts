import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { hasSupabaseConfig } from "@/lib/platform/supabase";
import { SemanticStore } from "./semantic-store";

// 连真实 Supabase + 真实 embedding API：没配则整组跳过（需要 DASHSCOPE_API_KEY）
const testUserId = process.env.MEMORY_TEST_USER_ID;
const canRun =
  hasSupabaseConfig() &&
  Boolean(process.env.DASHSCOPE_API_KEY) &&
  Boolean(testUserId);

describe("SemanticStore 语义召回", () => {
  const store = new SemanticStore();
  const ns = `test:semantic:${process.pid}:${Date.now()}`; // 唯一前缀，避免撞别人数据

  // 三条主题完全不同的记忆，用词上和后面的 query 故意不重叠
  const mutKey = `${ns}:mut`; // 第 3 个用例用，统一登记以便清理
  const seed = [
    { key: `${ns}:1`, content: "用户写代码偏爱简洁，不喜欢冗长的注释和样板" },
    { key: `${ns}:2`, content: "用户对香菜过敏，点餐时要避开" },
    { key: `${ns}:3`, content: "用户每周三晚上固定去打羽毛球" },
  ];

  beforeAll(async () => {
    if (!canRun) return;
    for (const m of seed) await store.set(m.key, m.content, { ns }, { userId: testUserId });
  });

  // 清理放 afterAll：无论断言成败都执行。绝不把 forget 写在断言后面，
  // 否则断言一失败就跳过清理，垃圾数据越堆越多、污染后续 recall。
  afterAll(async () => {
    if (!canRun) return;
    for (const m of seed) await store.forget(m.key, { userId: testUserId });
    await store.forget(mutKey, { userId: testUserId });
  });

  it.skipIf(!canRun)("用语义相近、用词不同的 query 能召回正确的那条", async () => {
    // query 用词和「偏爱简洁」那条几乎不重叠，靠的是「意思」
    const hits = await store.recall("这个人喜欢什么样的编程风格？", 3, {
      userId: testUserId,
    });

    expect(hits.length).toBeGreaterThan(0);

    // 召回的第一条（最相似）应该是「编程偏好」那条，而不是饮食/运动
    expect(hits[0].content).toContain("简洁");
    // 语义层的记录应带 score（相似度），且在合理范围
    expect(hits[0].score).toBeGreaterThan(0.3);

    // 打印出来，肉眼看排序效果（vitest 会显示）
    console.log(
      "召回排序:",
      hits.map((h) => `${h.score?.toFixed(3)} | ${h.content.slice(0, 20)}`),
    );
  });

  it.skipIf(!canRun)("get/list 不带 score（只有 recall 才有相似度）", async () => {
    const rec = await store.get(seed[0].key, { userId: testUserId });
    expect(rec).not.toBeNull();
    expect(rec!.score).toBeUndefined(); // 普通查询没有 similarity
  });

  it.skipIf(!canRun)("覆盖 set 后向量同步更新（同一条记忆按新语义召回）", async () => {
    // 先存「咖啡」，用「乐器」去 recall —— 此时这条应该不相关，分数低或召不回
    await store.set(mutKey, "用户喜欢喝美式咖啡", {}, { userId: testUserId });
    const before = await store.recall("乐器演奏 弹钢琴", 10, { userId: testUserId });
    const beforeScore = before.find((h) => h.key === mutKey)?.score ?? 0;

    // 覆盖成「弹钢琴」：upsert 会重算 embedding，向量应跟着变
    await store.set(mutKey, "用户在学习弹钢琴，每天练一小时", {}, { userId: testUserId });
    const after = await store.recall("乐器演奏 弹钢琴", 10, { userId: testUserId });
    const afterScore = after.find((h) => h.key === mutKey)?.score ?? 0;

    // 核心断言：改成「弹钢琴」后，对「乐器」query 的相似度明显升高
    // —— 证明 set 确实重算并更新了向量，不是存了新文本配旧向量
    expect(afterScore).toBeGreaterThan(beforeScore);
  });
});
