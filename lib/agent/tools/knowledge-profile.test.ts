import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_KNOWLEDGE_PROFILE_CHARS,
  normalizeCustomKnowledgeProfile,
  resolveKnowledgeProfile,
} from "./knowledge-profile";

describe("知识库画像覆盖层", () => {
  it("没有用户覆盖时使用系统画像", () => {
    const resolved = resolveKnowledgeProfile({
      source_hash: "source-v1",
      profile: "系统生成画像",
      metadata: { index_version: "index-v1" },
      updated_at: "2026-08-09T00:00:00.000Z",
    });

    expect(resolved).toMatchObject({
      exists: true,
      mode: "generated",
      generatedProfile: "系统生成画像",
      customProfile: "",
      effectiveProfile: "系统生成画像",
      indexVersion: "index-v1",
    });
  });

  it("用户覆盖优先生效，并产生独立路由版本", () => {
    const generated = resolveKnowledgeProfile({
      source_hash: "source-v1",
      profile: "系统生成画像",
      metadata: { index_version: "index-v1" },
    });
    const custom = resolveKnowledgeProfile({
      source_hash: "source-v1",
      profile: "系统生成画像",
      custom_profile: "重点覆盖 Agent Runtime 和记忆系统",
      metadata: { index_version: "index-v1" },
      custom_updated_at: "2026-08-09T01:00:00.000Z",
    });

    expect(custom).toMatchObject({
      mode: "custom",
      generatedProfile: "系统生成画像",
      customProfile: "重点覆盖 Agent Runtime 和记忆系统",
      effectiveProfile: "重点覆盖 Agent Runtime 和记忆系统",
    });
    expect(custom.indexVersion).not.toBe(generated.indexVersion);
  });

  it("规范化自定义文本并限制长度", () => {
    expect(normalizeCustomKnowledgeProfile("  RAG\n\n与 <Agent>  ")).toBe("RAG 与 Agent");
    expect(() => normalizeCustomKnowledgeProfile("   ")).toThrow("不能为空");
    expect(() => normalizeCustomKnowledgeProfile(
      "x".repeat(MAX_CUSTOM_KNOWLEDGE_PROFILE_CHARS + 1),
    )).toThrow(`不能超过 ${MAX_CUSTOM_KNOWLEDGE_PROFILE_CHARS} 个字符`);
  });
});
