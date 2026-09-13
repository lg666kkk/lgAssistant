import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import {
  encryptRuntimeConfigValue,
  decryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import type {
  ConfirmationStore,
  Continuation,
  ConfirmationResponse,
} from "@repo/application/mcp/continuation";
const TTL = 7200;
let redis: Redis | undefined;
function client() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });
    redis.on("error", () => console.warn("[confirmation] Redis unavailable"));
  }
  return redis;
}
function key(userId: string, token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("确认记录无效或已过期");
  return `tool-confirmation:${userId}:${token}`;
}
type RecordValue = {
  state: Continuation;
  responses: Record<string, ConfirmationResponse>;
};
const claims = new Map<string, RecordValue>();
export function createConfirmationStore(connection?: Redis): ConfirmationStore {
  const db = connection ?? client();
  return {
    async create(userId, state) {
      const token = randomUUID();
      await db.setex(
        key(userId, token),
        TTL,
        JSON.stringify({
          payload: encryptRuntimeConfigValue(
            JSON.stringify({ state, responses: {} }),
          ),
          busy: false,
        }),
      );
      return token;
    },
    async claim(userId, token, callId) {
      const k = key(userId, token);
      // Keep the claim marker and checkpoint in ONE key: allkeys-lru eviction can
      // expire the entire record, but can never evict only a lock and replay a write.
      const raw = (await db.eval(
        `local v=redis.call('GET',KEYS[1]); if not v then return '' end; local r=cjson.decode(v); if r.busy then return 'BUSY' end; r.busy=true; local ttl=redis.call('TTL',KEYS[1]); if ttl<1 then return '' end; redis.call('SETEX',KEYS[1],ttl,cjson.encode(r)); return r.payload`,
        1,
        k,
      )) as string;
      if (!raw) throw new Error("确认记录已过期，请重新发起请求");
      if (raw === "BUSY")
        throw new Error(
          "该调用正在处理或上次执行状态未知，请先核实结果，不要重复执行",
        );
      const record = JSON.parse(decryptRuntimeConfigValue(raw)) as RecordValue;
      claims.set(k, record);
      return {
        state: record.state,
        response: Object.prototype.hasOwnProperty.call(record.responses, callId)
          ? record.responses[callId]
          : undefined,
      };
    },
    async save(userId, token, state, callId, response) {
      const k = key(userId, token);
      const record = claims.get(k);
      if (!record) throw new Error("确认记录未锁定");
      record.state = state;
      record.responses[callId] = response;
      // Refresh state and release the lock atomically. Failed writes retain the lock.
      await db.setex(
        k,
        TTL,
        JSON.stringify({
          payload: encryptRuntimeConfigValue(JSON.stringify(record)),
          busy: false,
        }),
      );
      claims.delete(k);
    },
    async release(userId, token) {
      const k = key(userId, token);
      claims.delete(k);
      await db.eval(
        `local v=redis.call('GET',KEYS[1]); if not v then return 0 end; local r=cjson.decode(v); r.busy=false; local ttl=redis.call('TTL',KEYS[1]); if ttl>0 then redis.call('SETEX',KEYS[1],ttl,cjson.encode(r)) end; return 1`,
        1,
        k,
      );
    },
  };
}
