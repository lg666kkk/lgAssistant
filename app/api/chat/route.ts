import { withChatSessionLease } from "@/lib/chat/session-lease";
import { requireUser } from "@/lib/auth/server";
import { runChatUseCase } from "@repo/application/chat";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  return withChatSessionLease(request, user.id, (leasedRequest) => runChatUseCase({
    request: leasedRequest,
    userId: user.id,
    dependencies: createProductionChatDependencies(),
  }));
}
