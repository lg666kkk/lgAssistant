import { describe, it, expect, afterAll } from "vitest";
import { hasSupabaseConfig } from "@/lib/supabase";
import { LongTermStore } from "./longterm-store";

// 连真实 Supabase 的闭环测试：没配环境变量时整组跳过（CI 不挂）。
const hasConfig = hasSupabaseConfig();

describe("LongTermStore 闭环（set→get→覆盖→list→forget）", () => {
  const store = new LongTermStore();
  // 唯一 key：pid + 时间戳，避免并发/多人跑测试时撞 key
  const key = `test:longterm:${process.pid}:${Date.now()}`;

  // 兜底清理：万一断言中途失败，afterAll 也要把测试数据删掉
  afterAll(async () => {
    if (hasConfig) await store.forget(key);
  });

  it.skipIf(!hasConfig)("写入后能读回，字段正确", async () => {
    await store.set(key, "用户喜欢简洁的回答", { userId: "u-1" });

    const rec = await store.get(key);
    expect(rec).not.toBeNull();
    expect(rec!.content).toBe("用户喜欢简洁的回答");
    expect(rec!.layer).toBe("longterm");
    expect(rec!.metadata.userId).toBe("u-1");
    expect(rec!.createdAt).toBeTruthy(); // 映射 created_at → createdAt 成功
  });

  it.skipIf(!hasConfig)("同 key 再次 set 是覆盖而非新增", async () => {
    await store.set(key, "用户改主意了，喜欢详细解释", { userId: "u-1" });

    const rec = await store.get(key);
    expect(rec!.content).toBe("用户改主意了，喜欢详细解释"); // 内容被覆盖

    // 确认没产生第二行：list 里这个 key 只出现一次
    const all = await store.list(200);
    const hits = all.filter((r) => r.metadata.userId === "u-1" && r.content.includes("详细解释"));
    expect(hits.length).toBe(1);
  });

  it.skipIf(!hasConfig)("forget 后读不到，get 返回 null", async () => {
    await store.forget(key);
    const rec = await store.get(key);
    expect(rec).toBeNull(); // maybeSingle 查不到返回 null，不抛错
  });

  it.skipIf(!hasConfig)("get 不存在的 key 返回 null（不抛错）", async () => {
    const rec = await store.get(`test:longterm:does-not-exist:${Date.now()}`);
    expect(rec).toBeNull();
  });
});
