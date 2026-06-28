import {
  type ToolDefinition,
  type ToolResult,
  defaultToolRuntimePolicy,
} from "./types";

export type WebFetchInput = {
  url?: string;
  maxChars?: number;
};

type FetchPageResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bodyTruncatedByBytes: boolean;
  method: "node_fetch" | "jina_reader";
  rewriteNote?: string;
};

const DEFAULT_MAX_CHARS = 8000;
const MAX_CHARS_CAP = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const READER_PROXY_ORIGIN = "https://r.jina.ai/http://r.jina.ai/http://";

type UrlRewriteResult = {
  url: string;
  note?: string;
};

class WebFetchHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly contentType?: string,
  ) {
    super(message);
    this.name = "WebFetchHttpError";
  }
}

function parseInput(input: unknown): WebFetchInput {
  if (!input || typeof input !== "object") return {};
  const data = input as Record<string, unknown>;
  return {
    url: typeof data.url === "string" ? data.url : undefined,
    maxChars: typeof data.maxChars === "number" ? data.maxChars : undefined,
  };
}

function normalizeMaxChars(maxChars?: number) {
  if (!Number.isFinite(maxChars)) return DEFAULT_MAX_CHARS;
  return Math.min(Math.max(Math.floor(maxChars ?? DEFAULT_MAX_CHARS), 1000), MAX_CHARS_CAP);
}

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  if (host === "0.0.0.0" || host === "169.254.169.254" || host === "100.100.100.200") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }

  return false;
}

function validatePublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URL 格式无效");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("web_fetch 只支持 http/https URL");
  }

  if (!parsed.hostname || isPrivateHostname(parsed.hostname)) {
    throw new Error("出于安全限制，不能读取本机、内网或云元数据地址");
  }

  return parsed;
}

function rewriteKnownSourceUrl(rawUrl: string): UrlRewriteResult {
  const parsed = validatePublicHttpUrl(rawUrl);
  const host = parsed.hostname.toLowerCase();

  if (host === "github.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const [owner, repo, mode, ref, ...pathParts] = parts;
    if (owner && repo && ref && pathParts.length > 0) {
      if (mode === "blob" || mode === "raw") {
        return {
          url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${pathParts.join("/")}`,
          note: "GitHub 文件页面已自动改读 raw 原始文件",
        };
      }
    }
  }

  return { url: parsed.toString() };
}

function toReaderProxyUrl(rawUrl: string) {
  const parsed = validatePublicHttpUrl(rawUrl);
  return `${READER_PROXY_ORIGIN}${parsed.toString()}`;
}

function isSupportedContentType(contentType: string) {
  const type = contentType.toLowerCase().split(";")[0].trim();
  return (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    type === "text/plain" ||
    type === ""
  );
}

async function readResponseTextWithLimit(response: Response) {
  if (!response.body) {
    return {
      text: await response.text(),
      truncated: false,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      truncated = true;
      const remaining = Math.max(0, MAX_RESPONSE_BYTES - (received - value.byteLength));
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    truncated,
  };
}

async function fetchPage(rawUrl: string): Promise<FetchPageResult> {
  let current = validatePublicHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PersonalAssistantBot/1.0)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("网页重定向缺少 Location");
      current = validatePublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      throw new WebFetchHttpError(
        `网页请求失败：HTTP ${response.status}`,
        response.status,
        contentType,
      );
    }

    if (!isSupportedContentType(contentType)) {
      throw new WebFetchHttpError(
        `该 URL 不是可读取的网页内容：${contentType || "unknown"}`,
        response.status,
        contentType,
      );
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new Error(`网页响应过大：${contentLength} bytes`);
    }

    const { text, truncated } = await readResponseTextWithLimit(response);
    return {
      url: rawUrl,
      finalUrl: response.url || current.toString(),
      status: response.status,
      contentType,
      body: text,
      bodyTruncatedByBytes: truncated,
      method: "node_fetch",
    };
  }

  throw new Error(`网页重定向次数过多，超过 ${MAX_REDIRECTS} 次`);
}

async function fetchPageWithReader(rawUrl: string): Promise<FetchPageResult> {
  const original = validatePublicHttpUrl(rawUrl).toString();
  const readerUrl = toReaderProxyUrl(original);
  const page = await fetchPage(readerUrl);

  return {
    ...page,
    url: original,
    finalUrl: original,
    contentType: "text/plain; charset=utf-8",
    method: "jina_reader",
    rewriteNote: "原页面直接读取失败，已通过 Jina Reader 文本代理提取正文",
  };
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMeta(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return undefined;
}

function extractTitle(html: string) {
  return (
    extractMeta(html, "og:title") ||
    extractMeta(html, "twitter:title") ||
    decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "")
  );
}

function htmlToText(html: string) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|iframe|canvas)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

function isLikelyJavascriptShell(text: string, html?: string) {
  const lower = text.toLowerCase();
  if (
    lower.includes("you need to enable javascript to run this app") ||
    lower.includes("please enable javascript to continue") ||
    lower.includes("enable javascript")
  ) {
    return true;
  }

  if (!html) return false;

  const bodyTextLength = text.replace(/\s+/g, "").length;
  const scriptCount = countMatches(html, /<script\b/gi);
  const hasAppRoot =
    /<div[^>]+id=["'](?:root|app|__next|gatsby-focus-wrapper)["'][^>]*>\s*<\/div>/i.test(html);
  const hasBundledAssets =
    /\/(?:assets|static|_next)\/[^"']+\.(?:js|mjs|css)/i.test(html) ||
    /<script[^>]+type=["']module["'][^>]*>/i.test(html);

  return bodyTextLength < 500 && scriptCount >= 2 && (hasAppRoot || hasBundledAssets);
}

function detectBlockedReason(text: string, status: number, html?: string) {
  if (status >= 400) return `http_${status}`;
  if (isLikelyJavascriptShell(text, html)) return "javascript_rendered_page";
  if (!text || text.trim().length < 80) return "empty_content";
  const lower = text.toLowerCase();
  const patterns = [
    "access denied",
    "403 forbidden",
    "robot check",
    "please verify you are human",
    "login required",
    "sign in to continue",
    "captcha",
    "enable javascript",
    "page not found",
  ];
  return patterns.find((pattern) => lower.includes(pattern))?.replace(/\s+/g, "_");
}

function shouldTryReaderFallback(reason?: string, error?: unknown) {
  if (reason) {
    return [
      "empty_content",
      "javascript_rendered_page",
      "access_denied",
      "403_forbidden",
      "robot_check",
      "please_verify_you_are_human",
      "login_required",
      "sign_in_to_continue",
      "captcha",
      "enable_javascript",
    ].includes(reason);
  }

  if (error instanceof WebFetchHttpError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      (typeof error.status === "number" && error.status >= 500)
    );
  }

  return false;
}

function truncateMiddle(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head);
  return {
    text: `${text.slice(0, head)}\n\n...（中间内容已省略，原文共 ${text.length} 字符）...\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

function makeSnippet(text: string, title: string, maxChars = 500) {
  if (!text || text.length < 80) return title;
  const snippet = text.slice(0, maxChars);
  const boundary = Math.max(
    snippet.lastIndexOf("。"),
    snippet.lastIndexOf(". "),
    snippet.lastIndexOf("！"),
    snippet.lastIndexOf("？"),
  );
  return (boundary > 100 ? snippet.slice(0, boundary + 1) : snippet).trim();
}

function extractPlainTextTitle(text: string) {
  const markdownHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (markdownHeading) return markdownHeading;
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function formatForModel(input: {
  title: string;
  url: string;
  finalUrl: string;
  rewriteNote?: string;
  publishedDate?: string;
  author?: string;
  text: string;
  truncated: boolean;
}) {
  return [
    `标题：${input.title || "(无标题)"}`,
    `链接：${input.finalUrl || input.url}`,
    input.finalUrl !== input.url ? `原始请求：${input.url}` : undefined,
    input.rewriteNote ? `读取方式：${input.rewriteNote}` : undefined,
    input.author ? `作者：${input.author}` : undefined,
    input.publishedDate ? `发布时间：${input.publishedDate}` : undefined,
    input.truncated ? "说明：正文已按长度限制截断，保留开头和结尾。" : undefined,
    "",
    "正文：",
    input.text,
  ]
    .filter((item) => item !== undefined)
    .join("\n");
}

function buildWebFetchResult(input: {
  requestedUrl: string;
  fetchedUrl: string;
  page: FetchPageResult;
  maxChars?: number;
  rewriteNote?: string;
}): ToolResult {
  const contentType = input.page.contentType.toLowerCase();
  const rawText = contentType.includes("text/plain")
    ? input.page.body.trim()
    : htmlToText(input.page.body);
  const title = contentType.includes("text/plain")
    ? extractPlainTextTitle(rawText)
    : extractTitle(input.page.body);
  const description = contentType.includes("text/plain")
    ? undefined
    : extractMeta(input.page.body, "description") || extractMeta(input.page.body, "og:description");
  const author = contentType.includes("text/plain")
    ? undefined
    : extractMeta(input.page.body, "author") || extractMeta(input.page.body, "article:author");
  const publishedDate = contentType.includes("text/plain")
    ? undefined
    : extractMeta(input.page.body, "article:published_time") || extractMeta(input.page.body, "date");
  const blockedReason = detectBlockedReason(
    rawText,
    input.page.status,
    contentType.includes("html") ? input.page.body : undefined,
  );

  if (blockedReason) {
    return {
      ok: false,
      content: `网页读取成功，但未能提取到有效正文：${blockedReason}`,
      error: blockedReason,
      data: {
        url: input.requestedUrl,
        fetchedUrl: input.fetchedUrl,
        finalUrl: input.page.finalUrl,
        status: input.page.status,
        contentType: input.page.contentType,
        title,
        description,
        blockedReason,
        method: input.page.method,
        rewriteNote: input.rewriteNote ?? input.page.rewriteNote,
      },
      metadata: {
        url: input.requestedUrl,
        fetchedUrl: input.fetchedUrl,
        finalUrl: input.page.finalUrl,
        status: input.page.status,
        contentType: input.page.contentType,
        blockedReason,
        method: input.page.method,
        rewriteNote: input.rewriteNote ?? input.page.rewriteNote,
      },
    };
  }

  const max = normalizeMaxChars(input.maxChars);
  const compact = truncateMiddle(rawText, max);
  const snippet = makeSnippet(rawText, title);

  return {
    ok: true,
    content: formatForModel({
      title,
      url: input.requestedUrl,
      finalUrl: input.page.finalUrl,
      rewriteNote: input.rewriteNote ?? input.page.rewriteNote,
      author,
      publishedDate,
      text: compact.text,
      truncated: compact.truncated || input.page.bodyTruncatedByBytes,
    }),
    data: {
      url: input.requestedUrl,
      fetchedUrl: input.fetchedUrl,
      finalUrl: input.page.finalUrl,
      title,
      description,
      author,
      publishedDate,
      status: input.page.status,
      contentType: input.page.contentType,
      text: compact.text,
      snippet,
      wordCount: rawText.split(/\s+/).filter(Boolean).length,
      charCount: rawText.length,
      returnedChars: compact.text.length,
      truncated: compact.truncated,
      bodyTruncatedByBytes: input.page.bodyTruncatedByBytes,
      method: input.page.method,
      pagesFetched: 1,
      blockedReason: null,
      rewriteNote: input.rewriteNote ?? input.page.rewriteNote,
    },
    metadata: {
      url: input.requestedUrl,
      fetchedUrl: input.fetchedUrl,
      finalUrl: input.page.finalUrl,
      title,
      status: input.page.status,
      contentType: input.page.contentType,
      originalChars: rawText.length,
      returnedChars: compact.text.length,
      truncated: compact.truncated,
      method: input.page.method,
      rewriteNote: input.rewriteNote ?? input.page.rewriteNote,
    },
  };
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "读取一个公开网页 URL 的正文内容。适合在 web_search 找到候选结果后，对最相关网页进行精读；GitHub 文件页会自动改读 raw 原始文件。不要用于本地文件、内网地址、PDF、图片或非网页资源。",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要读取的公开网页 URL，必须是 http 或 https",
      },
      maxChars: {
        type: "number",
        description: "返回正文的最大字符数，默认 8000，最多 20000",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 10,
    timeoutSeconds: 20,
    memoryLimitMb: 256,
    sideEffect: "external",
    concurrencyGroup: "web",
    maxConcurrency: 3,
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const { url, maxChars } = parseInput(input);
    if (!url?.trim()) {
      return {
        ok: false,
        content: "缺少 url 参数",
        error: "Missing url",
      };
    }

    try {
      const rewritten = rewriteKnownSourceUrl(url);
      const page = await fetchPage(rewritten.url);
      const result = buildWebFetchResult({
        requestedUrl: url,
        fetchedUrl: rewritten.url,
        page,
        maxChars,
        rewriteNote: rewritten.note,
      });

      if (!result.ok && shouldTryReaderFallback(result.error)) {
        const fallbackPage = await fetchPageWithReader(url);
        return buildWebFetchResult({
          requestedUrl: url,
          fetchedUrl: toReaderProxyUrl(url),
          page: fallbackPage,
          maxChars,
        });
      }

      return result;
    } catch (error) {
      if (shouldTryReaderFallback(undefined, error)) {
        try {
          const fallbackPage = await fetchPageWithReader(url);
          return buildWebFetchResult({
            requestedUrl: url,
            fetchedUrl: toReaderProxyUrl(url),
            page: fallbackPage,
            maxChars,
          });
        } catch {
          // Fall through and return the original error below.
        }
      }

      return {
        ok: false,
        content: "网页读取失败",
        error: error instanceof Error ? error.message : "Web fetch failed",
      };
    }
  },
};
