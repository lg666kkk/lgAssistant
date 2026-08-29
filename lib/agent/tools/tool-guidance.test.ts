import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "./builtin";

// 这三条约束原来写在 system prompt 的静态策略段里（KNOWLEDGE_SEARCH_POLICY /
// SEARCH_QUERY_POLICY / WEB_SEARCH_CONTENT）。策略段改由 registry 元数据生成后，
// 能被代码保证的规则（调用次数、query 去重、时间过滤）已经下沉到 outputPolicy 和
// 检索工具内部，剩下这三条只能靠模型自觉，必须跟着工具描述走 —— 尤其在
// route=no_retrieval 时路由不做任何工具裁剪，工具描述是唯一的约束来源。
describe("tool descriptions carry the non-mechanizable guidance", () => {
  const registry = createBuiltinToolRegistry({ knowledgeProfile: "画像：RAG、Agent 设计笔记" });

  it("tells the model to rewrite the query and to prefer results over prior knowledge", () => {
    const description = registry.get("web_search")!.description;

    expect(description).toContain("改写成一个精确 query");
    expect(description).toContain("不要只依赖模型内部知识");
    expect(description).toContain("最多调用两次 web_search");
    expect(description).toContain("只有第一次证据不足或存在冲突时");
    expect(description).toContain("改写为不同 query");
    expect(registry.get("web_search")!.outputPolicy.retrieval?.maxCallsPerRun).toBe(2);
  });

  it("keeps the conditions for escalating from search results to a full page read", () => {
    const description = registry.get("web_fetch")!.description;

    expect(description).toContain("摘要不足以支撑答案");
    expect(description).toContain("互相冲突");
    expect(description).toContain("不要批量抓取");
  });

  it("keeps search_notes from being a reflexive default step", () => {
    const description = registry.get("search_notes")!.description;

    expect(description).toContain("不是默认检索步骤");
    expect(description).toContain("不要为了保险而检索");
    // 画像仍然拼在描述末尾，上面那句“命中本描述中的知识库画像”才有指向。
    expect(description).toContain("画像：RAG、Agent 设计笔记");
  });
});
