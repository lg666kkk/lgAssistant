import {
  CHUNKER_VERSION,
  DEFAULT_CHUNK_MAX_TOKENS,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
} from "@/lib/knowledge/chunking";
import { EMBEDDING_MODEL } from "@/lib/knowledge/embedding";
import { ragConfig } from "@/lib/platform/config";
import { requireUser } from "@/lib/auth/server";
import { listUserLlmCatalog } from "@/lib/llm/config-service";
import { getUserNotionConnection } from "@/lib/knowledge/connections/notion-config";

export const runtime = "nodejs";

function maskSecret(value: string | undefined) {
  if (!value) return null;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function has(value: string | undefined) {
  return Boolean(value && value.trim());
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const dashscopeBaseUrl =
    process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const llmCatalog = await listUserLlmCatalog(user.id).catch(() => null);
  const notionConnection = await getUserNotionConnection(user.id).catch(() => null);
  const defaultModel = llmCatalog?.models.find((model) =>
    model.id === llmCatalog.preferences.defaultModelId) ?? llmCatalog?.models[0];

  return Response.json(
    {
      groups: [
        {
          title: "数据库",
          items: [
            {
              key: "NEXT_PUBLIC_SUPABASE_URL",
              label: "Supabase URL",
              value: supabaseUrl ?? "-",
              configured: has(supabaseUrl),
              sensitive: false,
            },
            {
              key: "SUPABASE_SERVICE_ROLE_KEY",
              label: "Service Role Key",
              value: maskSecret(process.env.SUPABASE_SERVICE_ROLE_KEY),
              configured: has(process.env.SUPABASE_SERVICE_ROLE_KEY),
              sensitive: true,
            },
            {
              key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
              label: "Publishable Key",
              value: maskSecret(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
              configured: has(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
              sensitive: true,
            },
          ],
        },
        {
          title: "Notion",
          items: [
            {
              key: "USER_NOTION_CONNECTION",
              label: "Notion Integration Token",
              value: notionConnection?.tokenConfigured
                ? notionConnection.tokenHint
                : null,
              configured: notionConnection?.tokenConfigured === true,
              sensitive: true,
            },
            {
              key: "MAX_BLOCK_DEPTH",
              label: "Block 递归深度",
              value: String(notionConnection?.maxDepth ?? "-"),
              configured: Boolean(notionConnection),
              sensitive: false,
            },
          ],
        },
        {
          title: "Embedding",
          items: [
            {
              key: "DASHSCOPE_API_KEY",
              label: "DashScope API Key",
              value: maskSecret(process.env.DASHSCOPE_API_KEY),
              configured: has(process.env.DASHSCOPE_API_KEY),
              sensitive: true,
            },
            {
              key: "DASHSCOPE_BASE_URL",
              label: "DashScope Base URL",
              value: dashscopeBaseUrl,
              configured: true,
              sensitive: false,
            },
            {
              key: "EMBEDDING_MODEL",
              label: "Embedding Model",
              value: EMBEDDING_MODEL,
              configured: true,
              sensitive: false,
            },
          ],
        },
        {
          title: "Chunk",
          items: [
            {
              key: "CHUNKER_VERSION",
              label: "Chunker Version",
              value: CHUNKER_VERSION,
              configured: true,
              sensitive: false,
            },
            {
              key: "CHUNK_OPTIONS",
              label: "切分参数",
              value: `chars<=700, tokens<=${DEFAULT_CHUNK_MAX_TOKENS}, charOverlap=50, tokenOverlap=${DEFAULT_CHUNK_OVERLAP_TOKENS}, minChars=100`,
              configured: true,
              sensitive: false,
            },
          ],
        },
        {
          title: "检索",
          items: [
            {
              key: "RAG_SIMILARITY_THRESHOLD",
              label: "默认相似度阈值",
              value: String(ragConfig.similarityThreshold),
              configured: true,
              sensitive: false,
            },
            {
              key: "RAG_MAX_RESULTS",
              label: "最终 TopK 硬上限",
              value: String(ragConfig.maxResults),
              configured: true,
              sensitive: false,
            },
            {
              key: "RAG_CANDIDATE_POOL",
              label: "候选池",
              value: `topK*${ragConfig.candidateMultiplier}, max=${ragConfig.maxCandidates}`,
              configured: true,
              sensitive: false,
            },
            {
              key: "RAG_FUSION_STRATEGY",
              label: "融合策略",
              value: `${ragConfig.fusionStrategy}, rrfK=${ragConfig.rrfK}, dynamicWeights=${ragConfig.dynamicFusionWeights}`,
              configured: true,
              sensitive: false,
            },
            {
              key: "RAG_MULTI_QUERY_VECTOR",
              label: "Multi-query Vector",
              value: "enabled, maxQueries=3, parallel=true",
              configured: true,
              sensitive: false,
            },
            {
              key: "RAG_CROSS_ENCODER",
              label: "条件式 Cross-Encoder",
              value: ragConfig.crossEncoderEnabled
                ? `${ragConfig.crossEncoderMode}, model=${process.env.RAG_RERANK_MODEL || "-"}, candidates=${ragConfig.crossEncoderCandidateCount}`
                : "disabled (rule rerank fallback)",
              configured: !ragConfig.crossEncoderEnabled || (
                has(process.env.RAG_RERANK_URL)
                && has(process.env.RAG_RERANK_MODEL)
                && has(process.env.RAG_RERANK_API_KEY || process.env.DASHSCOPE_API_KEY)
              ),
              sensitive: false,
            },
            {
              key: "RAG_CONTEXT_BUDGET",
              label: "上下文预算",
              value: `maxTokens=${ragConfig.maxContextTokens}, parentMaxChars=${ragConfig.parentContextMaxChars}`,
              configured: true,
              sensitive: false,
            },
          ],
        },
        {
          title: "用户模型",
          items: [
            {
              key: "USER_LLM_PROVIDERS",
              label: "Provider",
              value: `${llmCatalog?.providers.length ?? 0} 个 Provider`,
              configured: Boolean(llmCatalog?.providers.length),
              sensitive: false,
            },
            {
              key: "USER_LLM_MODELS",
              label: "已启用模型",
              value: `${llmCatalog?.models.length ?? 0} 个模型`,
              configured: Boolean(llmCatalog?.models.length),
              sensitive: false,
            },
            {
              key: "USER_LLM_DEFAULT_MODEL",
              label: "默认模型",
              value: defaultModel
                ? `${defaultModel.providerName} / ${defaultModel.displayName}`
                : "未配置",
              configured: Boolean(defaultModel),
              sensitive: false,
            },
          ],
        },
        {
          title: "数据库表",
          items: [
            {
              key: "notion_pages",
              label: "页面元数据",
              value: "notion_pages",
              configured: true,
              sensitive: false,
            },
            {
              key: "documents",
              label: "RAG chunks",
              value: "documents",
              configured: true,
              sensitive: false,
            },
            {
              key: "compiled_wiki_pages",
              label: "编译 Wiki 页面",
              value: "compiled_wiki_pages",
              configured: true,
              sensitive: false,
            },
            {
              key: "compiled_wiki_edges",
              label: "编译 Wiki 关系",
              value: "compiled_wiki_edges",
              configured: true,
              sensitive: false,
            },
          ],
        },
      ],
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
