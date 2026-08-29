import { requireUser } from "@/lib/auth/server";
import { runChatUseCase } from "@repo/application/chat";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  return runChatUseCase({
    request,
    userId: user.id,
    dependencies: createProductionChatDependencies(),
  });
}
