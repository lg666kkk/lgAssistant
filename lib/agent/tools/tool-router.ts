/**
 * 负责把这类请求 变成真正的执行结果
 *
 * {
 *  "name": "get_current_time",
 *  "input": {
 *    "timezone": "Asia/Shanghai",
 *    "locale": "zh-CN"
 *  }
 * }
 *
 * 变成真正的执行结果
 * {
 *      ok: true,
 *      toolName: "get_current_time",
 *      content: "当前时间：...",
 * }
 */
import type {
  ToolCall,
  ToolExecutionResult,
  ExecuteToolCallOptions,
} from "./types";
import { ToolRegistry } from "./registry";

const toolRateLimitBuckets = new Map<
  string,
  {
    windowStartedAt: number;
    count: number;
  }
>();

function getRateLimitBucketKey(toolName: string, scopeId?: string) {
  return `${scopeId ?? "global"}:${toolName}`;
}

function checkRateLimit(toolName: string, rateLimit?: number, scopeId?: string) {
  if (!rateLimit) {
    return {
      ok: true,
      reason: "no rate limit",
    };
  }
  const now = Date.now();
  const windowMs = 60 * 1000; // 窗口大小是1分钟
  const bucketKey = getRateLimitBucketKey(toolName, scopeId);
  const bucket = toolRateLimitBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStartedAt >= windowMs) {
    toolRateLimitBuckets.set(bucketKey, {
      windowStartedAt: now,
      count: 1,
    });
    return { ok: true, reason: "rate limit check passed" };
  }
  if (bucket.count >= rateLimit) {
    return {
      ok: false,
      retryAfterMs: windowMs - (now - bucket.windowStartedAt),
      reason: "rate limit exceeded",
    };
  }
  bucket.count++;
  return {
    ok: true,
    reason: "rate limit check passed",
  };
}
/**
 *
 * 表示异步返回工具执行结果。
 * 为什么异步？
 * 因为工具可能会：
 *    读文件、查数据库、调 API、跑命令
 * 所以 Router 统一设计成异步。
 */
export async function executeToolCall(
  registry: ToolRegistry,
  toolCall: ToolCall,
  options: ExecuteToolCallOptions = {},
): Promise<ToolExecutionResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return {
      ok: false,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      content: `工具不存在：${toolCall.name}`,
      error: `Unknown tool: ${toolCall.name}`,
    };
  }
  if (tool.riskLevel === "confirm" && !options.approved) {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 需要用户确认后才能执行`,
      error: `Tool requires approval: ${tool.name}`,
      metadata: {
        status: "pending_confirmation",
        riskLevel: tool.riskLevel,
        runtime: tool.runtime,
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        },
      },
    };
  }

  if (tool.riskLevel === "dangerous" || tool.runtime.dangerous) {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 风险过高，已拒绝执行`,
      error: `Dangerous tool blocked: ${tool.name}`,
      metadata: {
        status: "blocked",
        riskLevel: tool.riskLevel,
        runtime: tool.runtime,
      },
    };
  }
  const rateLimitCheck = checkRateLimit(
    tool.name,
    tool.runtime.rateLimit,
    options.scopeId,
  );
  console.log("[RateLimit]", {
    toolName: tool.name,
    scopeId: options.scopeId,
    rateLimit: tool.runtime.rateLimit,
    result: rateLimitCheck,
  });
  if (!rateLimitCheck.ok) {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 达到调用频率限制`,
      error: `Rate limit exceeded: ${tool.name}`,
      metadata: {
        status: "rate_limited",
        riskLevel: tool.riskLevel,
        runtime: tool.runtime,
        retryAfterMs: rateLimitCheck.retryAfterMs,
      },
    };
  }

  const startedAt = Date.now();

  try {
    const result = await withTimeout(
      tool.execute(toolCall.input, {
        userId: options.userId,
        scopeId: options.scopeId,
        requestId: options.requestId,
      }),
      tool.runtime.timeoutSeconds,
      tool.name,
    );
    const durationMs = Date.now() - startedAt;
    return {
      ...result,
      toolName: tool.name,
      toolCallId: toolCall.id,
      metadata: {
        ...result.metadata,
        durationMs, // 耗时
        runtime: tool.runtime, // 运行策略
        costPerUse: tool.runtime.costPerUse, // 单次成本
      },
    };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 执行失败`,
      error: `Tool execution failed: ${e}`,
      metadata: {
        status: "failed",
        error: message,
        durationMs,
        runtime: tool.runtime,
        costPerUse: tool.runtime.costPerUse,
        timedOut: (e as Error).message.includes("timed out"),
      },
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutSeconds: number,
  toolName: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Tool ${toolName} timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
