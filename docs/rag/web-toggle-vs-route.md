# 联网开关与检索路由：权限边界 vs 优先级

> 相关：[agentic-rag-production.md](./agentic-rag-production.md#21-retrieval-router)（Router 全貌）、
> [span-chinese-labels.md](../agent/observability/span-chinese-labels.md)（`rag.route` 上报）。

## 这个改动解决什么问题

输入框那个「联网搜索」按钮亮着，但模型这一轮**根本没有联网工具**。

复现路径：用户开着联网搜索问「我之前写的 RAG 笔记讲了什么」→ Router 命中
`knowledge_profile_match`，`route=knowledge`（confidence 0.72）→
`filterToolsForRetrievalRoute` 按 route 硬过滤，把 `source==="web"` 的
`web_search` / `web_fetch` 从工具列表里摘掉 → 模型读完笔记发现内容是半年前的，
想补一条最新信息，但工具列表里没有。

更能说明问题的是这里的不对称：

| route | 联网工具是否可见（改动前） |
|---|---|
| `no_retrieval`（完全没检索信号） | ✅ 全保留 |
| `knowledge`（有知识库信号） | ❌ 被摘掉 |

**信号越强，能力越少。** 这显然不是设计意图，是「用工具集削减来表达优先级」这个手法的副作用。

## 核心概念

### 1. 两个约束的强度根本不同

```
webEnabled === false  →  产品级权限边界。用户主动关了联网，
                         Web 工具在任何 route 下都必须不可见。硬过滤。

webEnabled === true   →  用户已显式开启联网。route 此时只回答
                         「优先查哪儿」，不回答「能不能查」。软偏好。
```

关键事实：这个按钮在 [app/page.tsx:336](../../app/page.tsx:336) 里 **默认就是开的**
（`useState(true)`）。所以它天然不可能是「强制联网」——那样问「你好」也会去搜一圈。
它的语义只能是「允许联网」，那就不该在 route 判成 knowledge 时把这个许可收回去。

### 2. 优先级放 Prompt，不放工具过滤

改动后 [retrieval-router.ts](../../lib/agent/rag/retrieval-router.ts) 的过滤逻辑：

```ts
const webEnabled = options.webEnabled !== false;
const enabledTools = webEnabled
  ? tools
  : tools.filter((tool) => tool.outputPolicy.retrieval?.source !== "web");
if (route === "no_retrieval") return enabledTools;
const allowedSources = retrievalSourcesForRoute(route);
return enabledTools.filter((tool) => {
  const source = tool.outputPolicy.retrieval?.source;
  if (source === undefined) return true;
  if (source === "web" && webEnabled) return true; // 软偏好：保留兜底能力
  return allowedSources.has(source);
});
```

工具可见 ≠ 可以先用。所以 [segments.ts](../../lib/agent/prompt/segments.ts) 的检索计划段
在 `route=knowledge` 且联网开启时补一句显式排序：

> 用户本轮已开启联网，Web 检索工具可用但仅作兜底：必须先查个人知识库，
> 只有知识库无结果、证据明显过期或用户后续明确要求公开来源时，才允许改用 Web 检索。

联网关闭时这句不注入——Web 工具本就不可见，讲兜底顺序只是浪费 token 并制造矛盾。

## 决策记录

**为什么不干脆「按钮选中就强制 route=web」？**
默认开启。强制会让所有闲聊、写作、纯推理请求都白跑一次 Web 检索，成本和延迟都不划算，
还会破坏「结合我的笔记和最新政策对比一下」这类应该走 `both` 的查询。

**为什么 `route=web` 那侧仍然摘掉知识库工具，不做对称处理？**
两侧误判成本不对等。`web` 路由由显式线索触发（「最新」「官网」「联网查」），
判错的概率低；而 `knowledge` 那侧的触发条件里有 `profileMatch >= 0.18` 这种模糊匹配，
再叠加「联网按钮默认开启」，才构成了上面那个矛盾。等有实际 case 再动，不预先对称化。

**为什么不改成三态按钮（自动/强制联网/关闭）？**
那是 UI 改动，且「强制联网」的价值要等真实使用反馈。当前这版是纯后端改动，
先把「按钮亮着却不能联网」这个明确矛盾消掉。

## 踩坑记录

- 只改工具过滤是不够的：工具一旦可见，模型就可能跳过知识库直接联网。
  必须同步在 Prompt 里声明顺序，否则等于把路由决策白白扔了。
- `route=no_retrieval` 本来就保留全部工具，所以这次改动只影响 `knowledge` 一条路径，
  回归面很小。

## 验证

```bash
npx vitest run lib/agent/rag/retrieval-router.test.ts lib/agent/prompt/budget.test.ts
```

覆盖：knowledge 路由保留 Web 工具、`webEnabled: false` 仍硬过滤、`web` 路由收窄知识库工具、
Prompt 在联网开启时注入兜底顺序而关闭时不注入。
