import {
  formatDailyLeetCodePractice,
  getDailyLeetCodePractice,
} from "@/lib/leetcode/daily-practice";
import { requireUser } from "@/lib/auth/server";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const timeZone = url.searchParams.get("timeZone") ?? undefined;

  try {
    const practice = await getDailyLeetCodePractice({ timeZone, userId: user.id });
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
