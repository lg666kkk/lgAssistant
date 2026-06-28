import { CHUNKER_VERSION } from "@/lib/server/chunking";
import { EMBEDDING_MODEL } from "@/lib/server/embedding";
import { deepseekConfig, ragConfig } from "@/lib/config";

export const runtime = "nodejs";

function maskSecret(value: string | undefined) {
  if (!value) return null;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function has(value: string | undefined) {
  return Boolean(value && value.trim());
}

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const dashscopeBaseUrl =
    process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";

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
              key: "NOTION_API_KEY",
              label: "Notion API Key",
              value: maskSecret(process.env.NOTION_API_KEY),
              configured: has(process.env.NOTION_API_KEY),
              sensitive: true,
            },
            {
              key: "MAX_BLOCK_DEPTH",
              label: "Block 递归深度",
              value: "8",
              configured: true,
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
              value: "chunkSize=700, overlap=50, minChunkSize=100",
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
              label: "默认返回数量",
              value: String(ragConfig.maxResults),
              configured: true,
              sensitive: false,
            },
          ],
        },
        {
          title: "LLM 编译",
          items: [
            {
              key: "DEEPSEEK_API_KEY/ANTHROPIC_API_KEY",
              label: "LLM API Key",
              value: maskSecret(process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY),
              configured: has(process.env.DEEPSEEK_API_KEY) || has(process.env.ANTHROPIC_API_KEY),
              sensitive: true,
            },
            {
              key: "DEEPSEEK_BASE_URL/ANTHROPIC_BASE_URL",
              label: "LLM Base URL",
              value: deepseekConfig.baseURL,
              configured: true,
              sensitive: false,
            },
            {
              key: "LLM_MODEL",
              label: "编译模型",
              value: deepseekConfig.model,
              configured: true,
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
