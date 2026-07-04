import Redis from "ioredis";
import type { SessionMessage, SessionStore } from "./types";

// 会话默认保留 2 小时（单位：秒）。
// TTL = Redis 的「自动过期」能力：时间到了自动删，不用手动清理。
// 这正是选 Redis 而不是 Postgres 的核心原因之一。
const DEFAULT_TTL_SECONDS = 2 * 60 * 60; // 2h

// Redis key 格式：session:{userId}:{sessionId}:messages
// 加前缀是好习惯 —— 将来 Redis 里可能存其他东西，前缀防止 key 命名冲突
function sessionKey(userId: string, sessionId: string): string {
  return `session:${userId}:${sessionId}:messages`;
}

type RedisSessionClient = {
  rpush(key: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
};

class UpstashRestSessionClient implements RedisSessionClient {
  constructor(
    private readonly restUrl: string,
    private readonly token: string,
  ) {}

  private async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.restUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    const payload = (await response.json()) as { result?: T; error?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `Upstash REST error: ${response.status}`);
    }
    return payload.result as T;
  }

  async rpush(key: string, value: string): Promise<unknown> {
    return this.command(["RPUSH", key, value]);
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    return this.command(["EXPIRE", key, seconds]);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.command<string[]>(["LRANGE", key, start, stop]);
  }

  async del(key: string): Promise<unknown> {
    return this.command(["DEL", key]);
  }

  async quit(): Promise<unknown> {
    return undefined;
  }
}

/**
 * 会话记忆实现：本次对话的消息历史，存本地 Redis。
 * 和 MemoryStore 是平级关系（不继承）—— 访问模式是「列表追加/读取」，不是 key-value。
 *
 * Redis 数据结构：List（列表）
 *   RPUSH  → append（追加到列表尾部）
 *   LRANGE → getHistory（读出整个列表）
 *   DEL    → clear（删掉整个列表）
 *   EXPIRE → 设 TTL（每次写入时刷新过期时间）
 *
 * 生产升级路径：把 new Redis() 换成 Upstash 的 HTTP client，接口不变，主循环不动。
 * 当前局限：本地 Redis 进程内存，Next.js Serverless 部署时每次冷启动连接会重建，
 * 但数据在 Redis 里持久，不受冷启动影响（这点比内存版好）。
 */
export class RedisSessionStore implements SessionStore {
  private client: RedisSessionClient;

  constructor(redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      this.client = new UpstashRestSessionClient(
        process.env.UPSTASH_REDIS_REST_URL,
        process.env.UPSTASH_REDIS_REST_TOKEN,
      );
      return;
    }

    this.client = new Redis(redisUrl, {
      // 连接失败时不要无限重试（测试/开发时 Redis 可能没跑）
      maxRetriesPerRequest: 3,
      // 连接失败静默报错，不崩进程
      lazyConnect: true,
    });

    this.client.on("error", (err) => {
      // 只 log，不抛。Redis 挂了不该让整个对话崩掉
      console.error("[SessionStore] Redis 连接错误:", err.message);
    });
  }

  async append(userId: string, sessionId: string, message: SessionMessage): Promise<void> {
    const key = sessionKey(userId, sessionId);
    // RPUSH：把消息序列化成 JSON 字符串追加到列表尾部
    // Redis List 天然有序（按插入顺序），不需要额外排序字段
    await this.client.rpush(key, JSON.stringify(message));
    // 每次追加后刷新 TTL：「2 小时内没有新消息」才过期
    // 如果不刷新，2 小时是从「第一条消息」算，活跃对话会提前过期
    await this.client.expire(key, DEFAULT_TTL_SECONDS);
  }

  async getHistory(userId: string, sessionId: string): Promise<SessionMessage[]> {
    const key = sessionKey(userId, sessionId);
    // LRANGE key 0 -1：读出列表从 0 到最后一个元素（即全部）
    // 返回的是字符串数组，每个元素是序列化的 JSON
    const items = await this.client.lrange(key, 0, -1);
    // 反序列化回 SessionMessage 对象
    return items.map((item) => JSON.parse(item) as SessionMessage);
  }

  async clear(userId: string, sessionId: string): Promise<void> {
    // DEL：直接删掉整个 key（列表），比逐条删快得多
    await this.client.del(sessionKey(userId, sessionId));
  }

  // 优雅关闭连接（进程退出时调用）
  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
