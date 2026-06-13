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

export async function GET() {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "缺少环境变量 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY" },
      { status: 503 },
    );
  }

  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
    });

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
