import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 用户隔离的应用层回归。
 *
 * 为什么这组断言必须存在：lib/platform/supabase.ts 用的是 SUPABASE_SERVICE_ROLE_KEY，
 * service-role **绕过所有 RLS**。也就是说数据库那层的 `auth.uid() = user_id` 策略
 * 当前拦不住任何东西，唯一的防线在应用层——每次调用都必须自己带上正确的 userId。
 *
 * 一旦某条路径漏了 userId 而代码仍然发出 RPC，条件就退化成跨用户匹配：
 * 读会读到别人的记忆，删会删掉别人的记忆，而且没有任何一层会报错。
 * 所以这里断言的是「漏 userId 时一次 RPC 都不发」，而不是「RPC 返回空」。
 */
const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/lib/platform/supabase", () => ({
  hasSupabaseConfig: () => true,
  getSupabase: () => ({ rpc, from }),
}));

describe("service-role 下的用户隔离", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
    rpc.mockResolvedValue({ data: 0, error: null });
  });

  it("purgeMemoryKey 缺少 userId 时不发出任何 RPC", async () => {
    const { purgeMemoryKey } = await import("./atomic-writer");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(purgeMemoryKey("location:residence", undefined)).resolves.toBe(0);

    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("purgeMemoryKey 带 userId 时把 p_user_id 显式传进 RPC", async () => {
    const { purgeMemoryKey } = await import("./atomic-writer");
    rpc.mockResolvedValue({ data: 3, error: null });

    await expect(purgeMemoryKey("location:residence", "u-1")).resolves.toBe(3);

    expect(rpc).toHaveBeenCalledWith("purge_memory", {
      p_user_id: "u-1",
      p_key: "location:residence",
    });
  });

  it("MemoryWriter.upsert 缺少 userId 时不发出 RPC，也不去算 embedding", async () => {
    const { MemoryWriter } = await import("./atomic-writer");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 不传 userId 就应该在任何外部调用之前返回。若顺序写错（先 embed 再校验），
    // 这里会因为缺 DASHSCOPE_API_KEY 或发出真实网络请求而失败。
    await new MemoryWriter().upsert("k", "c", {}, {});

    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("MemoryWriter.invalidate 缺少 userId 时不发出 RPC", async () => {
    const { MemoryWriter } = await import("./atomic-writer");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new MemoryWriter().invalidate("k", {});

    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("两个 store 的 forget 缺少 userId 时不发出 RPC（改走 purge 后仍然守住）", async () => {
    const { LongTermStore } = await import("./longterm-store");
    const { SemanticStore } = await import("./semantic-store");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new LongTermStore().forget("k", {});
    await new SemanticStore().forget("k", {});

    expect(rpc).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("upsert_memory 抛 40001 时转成 MemoryVersionConflictError，不被当成普通失败吞掉", async () => {
    const { MemoryWriter, MemoryVersionConflictError } = await import("./atomic-writer");
    rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "memory_version_conflict: key=budget:car" },
    });

    // 冲突必须是一个可识别的类型：调用方要据此重读候选、重做判定。
    // 混进普通 Error 只会被记一条日志然后丢掉这条事实。
    const writer = new MemoryWriter();
    (writer as unknown as { embedder: { embedSingle: (t: string) => Promise<number[]> } }).embedder =
      { embedSingle: async () => [0.1] };

    await expect(
      writer.upsert("budget:car", "购车预算 8w", {}, { userId: "u-1", expectedVersion: 2 }),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
  });
});
