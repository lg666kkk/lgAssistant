import Redis from "ioredis";

export type RedisCommandClient = {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  rpush(key: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
};

type RedisCommandArg = string | number;

class UpstashRestRedisClient implements RedisCommandClient {
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

  async get(key: string): Promise<string | null> {
    return this.command<string | null>(["GET", key]);
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    return this.command(["SETEX", key, seconds, value]);
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

  async quit(): Promise<unknown> {
    return undefined;
  }
}

export function createRedisClient(input: {
  redisUrl?: string;
  errorLabel: string;
}): RedisCommandClient {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashRestRedisClient(
      process.env.UPSTASH_REDIS_REST_URL,
      process.env.UPSTASH_REDIS_REST_TOKEN,
    );
  }

  const redis = new Redis(
    input.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    },
  );
  redis.on("error", (error) => {
    console.error(`[${input.errorLabel}] Redis 连接错误:`, error.message);
  });
  return redis;
}
