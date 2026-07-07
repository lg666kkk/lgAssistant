import { describe, it, expect, afterAll } from "vitest";
import { hasSupabaseConfig } from "@/lib/supabase";
import { recallForPrompt, consolidate } from "./memory-flow";
import { LongTermStore } from "./longterm-store";
import { SemanticStore } from "./semantic-store";

// 端到端：真实 Supabase + 真实模型调用（抽取 + embedding）
// consolidate 用的模型鉴权在 vitest 环境下和 Next.js 运行时不同（shell token vs .env.local）
// 需要显式设置 CONSOLIDATE_TEST=1 才跑，避免 CI / 普通 vitest run 因 401 失败
const canRun =
  hasSupabaseConfig() &&
  Boolean(process.env.DASHSCOPE_API_KEY) &&
  Boolean(process.env.MEMORY_TEST_USER_ID) &&
  process.env.CONSOLIDATE_TEST === "1";
const sessionId = `test-flow-${process.pid}-${Date.now()}`;
const testUserId = process.env.MEMORY_TEST_USER_ID;

describe("记忆流动闭环（沉淀 → 召回）", () => {
  const longTerm = new LongTermStore();
  const semantic = new SemanticStore();

  // afterAll 兜底清理：consolidate 写了哪些 key，测试里收集后统一删
  const savedKeys: string[] = [];
  afterAll(async () => {
    if (!canRun) return;
    for (const k of savedKeys) {
      await longTerm.forget(k, { userId: testUserId });
      await semantic.forget(k, { userId: testUserId });
    }
  });

  it.skipIf(!canRun)(
    "对话里透露的长期偏好，被 consolidate 抽取并写回",
    async () => {
      const conversation = [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
        { role: "user", content: "提醒一下，我对香菜过敏，以后给我推荐菜别带香菜" },
      ];

      const saved = await consolidate(conversation, { sessionId, userId: testUserId });
      saved.forEach((r) => savedKeys.push(r.key));

      // 模型应抽出「香菜过敏」这类长期事实
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.some((r) => r.content.includes("香菜"))).toBe(true);
    },
  );

  it.skipIf(!canRun)(
    "沉淀后，用语义相近的问题能召回到这条记忆",
    async () => {
      // 注意：这里依赖上一个用例已写入。recall 用「饮食禁忌」这种不含「香菜」字样的问法
      const systemText = await recallForPrompt("用户有什么饮食上的禁忌或过敏？", {
        userId: testUserId,
      });

      expect(systemText).toContain("香菜"); // 召回成功并拼进 system 文本
      expect(systemText).toContain("已知信息"); // 是拼好的 system 段落格式
    },
  );

  it.skipIf(!canRun)("一次性任务不该被沉淀（验证 LLM 判断力）", async () => {
    const conversation = [
      { role: "user", content: "帮我算一下 23 乘以 17 等于多少" },
      { role: "assistant", content: "23 × 17 = 391" },
    ];
    const saved = await consolidate(conversation, { sessionId, userId: testUserId });
    saved.forEach((r) => savedKeys.push(r.key));

    // 「算个乘法」是一次性任务，不该抽成长期记忆
    expect(saved.length).toBe(0);
  });
});
