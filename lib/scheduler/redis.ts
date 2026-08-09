import { createRedisClient, type RedisCommandClient } from "@/lib/platform/redis";

type SchedulerRedisClient = Pick<
  RedisCommandClient,
  "zadd" | "zrangebyscore" | "zrem" | "del"
>;

let schedulerRedis: SchedulerRedisClient | null = null;

export function getSchedulerRedis(): SchedulerRedisClient {
  if (schedulerRedis) return schedulerRedis;

  schedulerRedis = createRedisClient({
    errorLabel: "scheduler",
  });
  return schedulerRedis;
}
