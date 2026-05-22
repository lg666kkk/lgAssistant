import {
  formatDailyLeetCodePractice,
  getDailyLeetCodePractice,
} from "@/lib/leetcode/daily-practice";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const timeZone = url.searchParams.get("timeZone") ?? undefined;

  try {
    const practice = await getDailyLeetCodePractice({ timeZone });
    return Response.json({
      ok: true,
      content: formatDailyLeetCodePractice(practice),
      data: practice,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Get daily LeetCode practice failed",
      },
      { status: 500 },
    );
  }
}
