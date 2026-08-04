import { describe, expect, it } from "vitest";
import { buildUpsertParams } from "./atomic-writer";
import type { MemoryWriteMetadata } from "./types";

describe("原子写入参数构建", () => {
  const metadata: MemoryWriteMetadata = {
    type: "preference",
    source: "user_explicit",
    confidence: 0.9,
    importance: 0.7,
    status: "active",
    evidence: { role: "user", excerpt: "我不吃辣" },
    sessionId: "s-1",
  };

  it("把 metadata 拍平成 RPC 命名参数，并冗余保留 metadata jsonb", () => {
    const params = buildUpsertParams({
      userId: "u-1",
      key: "diet:spicy:no",
      content: "用户不吃辣",
      embedding: [0.1, 0.2, 0.3],
      metadata,
      now: "2026-07-18T00:00:00.000Z",
    });

    expect(params).toMatchObject({
      p_user_id: "u-1",
      p_key: "diet:spicy:no",
      p_content: "用户不吃辣",
      p_embedding: [0.1, 0.2, 0.3],
      p_memory_type: "preference",
      p_source: "user_explicit",
      p_confidence: 0.9,
      p_importance: 0.7,
      p_status: "active",
      p_valid_from: "2026-07-18T00:00:00.000Z",
      p_valid_to: null,
    });
    expect(params.p_evidence).toEqual({ role: "user", excerpt: "我不吃辣" });
    // metadata jsonb 仍保留全量并补上 userId
    expect(params.p_metadata).toMatchObject({ sessionId: "s-1", userId: "u-1" });
  });

  it("非法/缺失字段回退到安全默认，避免违反 CHECK 约束", () => {
    const params = buildUpsertParams({
      userId: "u-2",
      key: "k",
      content: "c",
      embedding: [],
      metadata: { type: "bogus" as never, confidence: 9, source: undefined },
      now: "2026-07-18T00:00:00.000Z",
    });
    expect(params.p_memory_type).toBe("fact");
    expect(params.p_source).toBe("inferred");
    expect(params.p_confidence).toBe(1); // clamp 到 [0,1]
    expect(params.p_status).toBe("active");
    expect(params.p_evidence).toBeNull();
  });

  it("归档参数缺省时不传假值：effective_at / expected_version 为 null 表示不校验", () => {
    const params = buildUpsertParams({
      userId: "u-3",
      key: "k",
      content: "c",
      embedding: [],
      metadata,
      now: "2026-08-04T00:00:00.000Z",
    });
    // p_effective_at 为 null 时由 RPC 内部退化到 p_valid_from，不能在这里塞 NOW()：
    // 塞了就等于把处理时刻写进有效时间轴。
    expect(params.p_effective_at).toBeNull();
    // 拿不到候选版本时必须传 null（放弃乐观校验，靠 FOR UPDATE 兜底），
    // 不能传 0/1 这种猜测值——那会让校验在错误的前提下通过。
    expect(params.p_expected_version).toBeNull();
    expect(params.p_supersede_kind).toBe("evolution");
    expect(params.p_request_id).toBeNull();
  });

  it("correction 与 evolution 作为独立参数下传，不由 SQL 猜测", () => {
    const params = buildUpsertParams({
      userId: "u-4",
      key: "budget:car",
      content: "购车预算 8w",
      embedding: [],
      metadata,
      now: "2026-08-04T00:00:00.000Z",
      effectiveAt: "2026-08-03T10:00:00.000Z",
      supersedeKind: "correction",
      expectedVersion: 3,
      requestId: "req-1",
    });
    expect(params.p_effective_at).toBe("2026-08-03T10:00:00.000Z");
    expect(params.p_supersede_kind).toBe("correction");
    expect(params.p_expected_version).toBe(3);
    expect(params.p_request_id).toBe("req-1");
  });
});
