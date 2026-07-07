import Redis from "ioredis";

type RedisCommandArg = string | number;

type SchedulerRedisClient = {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

class UpstashRestSchedulerRedisClient implements SchedulerRedisClient {
  constructor(
    private readonly restUrl: string,
    private readonly token: string,
  ) {}

  private async command<T>(command: RedisCommandArg[]): Promise<T> {
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

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    return this.command(["ZADD", key, score, member]);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    return this.command<string[]>(["ZRANGEBYSCORE", key, min, max]);
  }

  async zrem(key: string, ...members: string[]): Promise<unknown> {
    if (members.length === 0) return 0;
    return this.command(["ZREM", key, ...members]);
  }

  async del(key: string): Promise<unknown> {
    return this.command(["DEL", key]);
  }
}

let schedulerRedis: SchedulerRedisClient | null = null;

export function getSchedulerRedis(): SchedulerRedisClient {
  if (schedulerRedis) return schedulerRedis;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    schedulerRedis = new UpstashRestSchedulerRedisClient(
      process.env.UPSTASH_REDIS_REST_URL,
      process.env.UPSTASH_REDIS_REST_TOKEN,
    );
    return schedulerRedis;
  }

  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  redis.on("error", (error) => {
    console.error("[scheduler] Redis 连接错误:", error.message);
  });

  schedulerRedis = redis;
  return schedulerRedis;
}
