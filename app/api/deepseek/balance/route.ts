import { requireUser } from "@/lib/auth/server";
import { listUserLlmCatalog, resolveUserLlmModel } from "@/lib/llm/config-service";
import { createSafeProviderFetch } from "@/lib/llm/url-safety";

type DeepSeekBalanceInfo = {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
};

type DeepSeekBalanceResponse = {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
};

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const catalog = await listUserLlmCatalog(user.id).catch(() => null);
  const deepseekProvider = catalog?.providers.find((provider) => {
    try {
      return new URL(provider.baseUrl).hostname === "api.deepseek.com";
    } catch {
      return false;
    }
  });
  const model = deepseekProvider?.models.find((candidate) => candidate.enabled);
  if (!deepseekProvider || !model) {
    return Response.json(
      { error: "当前用户未配置 DeepSeek Provider" },
      { status: 503 },
    );
  }

  try {
    const resolved = await resolveUserLlmModel(user.id, model.id);
    const response = await createSafeProviderFetch("https://api.deepseek.com", 15_000)(
      "https://api.deepseek.com/user/balance",
      {
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      cache: "no-store",
      },
    );

    const data = (await response.json().catch(() => null)) as
      | DeepSeekBalanceResponse
      | { error?: unknown }
      | null;

    if (!response.ok) {
      return Response.json(
        {
          error: "DeepSeek 余额查询失败",
          status: response.status,
          detail: data,
        },
        { status: response.status },
      );
    }

    return Response.json(data);
  } catch (error) {
    return Response.json(
      {
        error: "DeepSeek 余额查询失败",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
