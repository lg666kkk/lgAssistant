import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { RedisSessionStore } from "./session-store";

// 连真实本地 Redis：6379 默认端口
const store = new RedisSessionStore();
const sid = `test-session-${process.pid}`; // 唯一 sessionId，避免并发跑测试时互相污染

describe("RedisSessionStore 闭环（append→getHistory→clear）", () => {
  // 每个用例跑前清空，保证用例之间互不影响
  beforeEach(async () => {
    await store.clear(sid);
  });

  // afterAll 兜底清理（即使用例中途失败也会跑）
  afterAll(async () => {
    await store.clear(sid);
    await store.disconnect();
  });

  it("append 后能 getHistory 读回，顺序正确", async () => {
    await store.append(sid, { role: "user", content: "你好" });
    await store.append(sid, { role: "assistant", content: "你好！有什么可以帮你？" });
    await store.append(sid, { role: "user", content: "今天天气怎么样" });

    const history = await store.getHistory(sid);

    expect(history).toHaveLength(3);
    // 顺序必须和插入顺序一致（Redis List 保证）
    expect(history[0]).toEqual({ role: "user", content: "你好" });
    expect(history[1]).toEqual({ role: "assistant", content: "你好！有什么可以帮你？" });
    expect(history[2]).toEqual({ role: "user", content: "今天天气怎么样" });
  });

  it("clear 后 getHistory 返回空数组", async () => {
    await store.append(sid, { role: "user", content: "测试消息" });
    await store.clear(sid);

    const history = await store.getHistory(sid);
    expect(history).toHaveLength(0); // DEL 删掉整个 key，LRANGE 返回空
  });

  it("getHistory 不存在的 session 返回空数组（不报错）", async () => {
    const history = await store.getHistory(`nonexistent-${Date.now()}`);
    expect(history).toHaveLength(0); // Redis LRANGE 对不存在的 key 返回 []，不报错
  });

  it("多次 append 是追加不是覆盖", async () => {
    await store.append(sid, { role: "user", content: "第一条" });
    await store.append(sid, { role: "user", content: "第二条" });
    await store.append(sid, { role: "user", content: "第三条" });

    const history = await store.getHistory(sid);
    expect(history).toHaveLength(3); // 三条都在，不是只有最后一条
  });
});
