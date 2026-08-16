import { chatModelOptions, type ChatModelId } from "@/lib/agent/models";
import { meteredModelOptions } from "@/lib/agent/observability/metered-models";
import { aggregateUsageTraces } from "@/lib/agent/observability/usage-aggregation";
import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { requireUser } from "@/lib/auth/server";

// GET /api/usage?limit=500&page=1&pageSize=20
// 基于 agent_traces 聚合真实 token usage 和估算费用。
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  if (!hasSupabaseConfig()) {
    return Response.json(
      { error: "未配置 Supabase，无法读取 usage" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(
    Math.max(5, Number(url.searchParams.get("pageSize")) || 20),
    100,
  );

  const { data, error, count } = await getSupabase()
    .from("agent_traces")
    .select(
      "id, request_id, session_id, total_duration_ms, metrics, steps, created_at, sessions(title)",
      { count: "exact" },
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const aggregated = aggregateUsageTraces(data ?? []);
  const recentRequests = aggregated.requests.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  return Response.json({
    total: aggregated.total,
    models: aggregated.models,
    recentRequests,
    pagination: {
      page,
      pageSize,
      totalItems: aggregated.requests.length,
      totalTraceCount: count ?? null,
      hasPreviousPage: page > 1,
      hasNextPage: page * pageSize < aggregated.requests.length,
    },
    knownModels: [
      ...chatModelOptions.map((item) => ({
        id: item.id satisfies ChatModelId,
        name: item.name,
        category: "chat" as const,
        pricing: item.pricing,
      })),
      ...meteredModelOptions.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        pricing: { input: item.inputCnyPerMillionTokens },
      })),
    ],
  });
}
