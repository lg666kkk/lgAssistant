import type { ChatUserContextPort } from "@repo/application/chat/ports";
import { readKnowledgeProfileForTool } from "@/lib/agent/tools/knowledge-profile";
import { resolveUserLlmModel } from "@/lib/llm/config-service";
import { resolveUserMemoryConfig } from "@/lib/memory-config/service";
import { resolveUserProfile } from "@/lib/user-profile/service";

export function createChatUserContextAdapter(): ChatUserContextPort {
  return {
    resolveModel: resolveUserLlmModel,
    resolveMemoryConfig: resolveUserMemoryConfig,
    resolveUserProfile,
    readKnowledgeProfile: async (userId) =>
      (await readKnowledgeProfileForTool({ userId })) ?? null,
  };
}
