import Redis from "ioredis";
import type { StorageAdapter, EndpointRow, RequestRecord, NewRequestData } from "../storage";
import { EXPIRATION_MS, MAX_REQUESTS_PER_ENDPOINT } from "../storage";

// Redis key helpers
const endpointKey = (id: string) => `endpoint:${id}`;
const requestsKey = (id: string) => `requests:${id}`;
const seqKey = (id: string) => `request_seq:${id}`;

export class RedisAdapter implements StorageAdapter {
  private redis: Redis;

  // Use rediss:// URL scheme for TLS (required for Azure Cache for Redis)
  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async getEndpoint(id: string): Promise<EndpointRow | undefined> {
    const data = await this.redis.hgetall(endpointKey(id));
    if (!data || Object.keys(data).length === 0) return undefined;
    return {
      id: data.id,
      created_at: data.created_at,
      expires_at: data.expires_at,
      password_hash: data.password_hash || null,
    };
  }

  async createEndpoint(id: string, passwordHash: string | null): Promise<EndpointRow> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_MS);
    const unixSeconds = Math.floor(expiresAt.getTime() / 1000);

    await this.redis.hset(endpointKey(id), {
      id,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      password_hash: passwordHash ?? "",
    });
    await this.redis.expireat(endpointKey(id), unixSeconds);

    return {
      id,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      password_hash: passwordHash,
    };
  }

  async refreshExpiration(id: string): Promise<void> {
    const newExpiresAt = new Date(Date.now() + EXPIRATION_MS);
    const unixSeconds = Math.floor(newExpiresAt.getTime() / 1000);

    await this.redis.hset(endpointKey(id), "expires_at", newExpiresAt.toISOString());
    await Promise.all([
      this.redis.expireat(endpointKey(id), unixSeconds),
      this.redis.expireat(requestsKey(id), unixSeconds),
      this.redis.expireat(seqKey(id), unixSeconds),
    ]);
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.redis.del(endpointKey(id), requestsKey(id), seqKey(id));
  }

  async cleanupExpired(): Promise<void> {
    // Redis TTL handles expiry automatically
  }

  async saveRequest(data: NewRequestData): Promise<RequestRecord> {
    const id = await this.redis.incr(seqKey(data.endpoint_id));
    const record: RequestRecord = {
      id,
      endpoint_id: data.endpoint_id,
      method: data.method,
      headers: data.headers,
      body: data.body,
      truncated: data.truncated ? 1 : 0,
      query: data.query,
      created_at: data.created_at,
      path: data.path,
      ip: data.ip,
    };
    await this.redis.zadd(requestsKey(data.endpoint_id), id, JSON.stringify(record));
    return record;
  }

  async getRequests(endpointId: string, limit = 100): Promise<RequestRecord[]> {
    const items = await this.redis.zrevrange(requestsKey(endpointId), 0, limit - 1);
    return items.map((item) => JSON.parse(item) as RequestRecord);
  }

  async getRequest(endpointId: string, requestId: number): Promise<RequestRecord | undefined> {
    const items = await this.redis.zrangebyscore(requestsKey(endpointId), requestId, requestId);
    return items.length ? (JSON.parse(items[0]) as RequestRecord) : undefined;
  }

  async deleteRequest(endpointId: string, requestId: number): Promise<boolean> {
    const removed = await this.redis.zremrangebyscore(requestsKey(endpointId), requestId, requestId);
    return removed > 0;
  }

  async deleteRequests(endpointId: string): Promise<number> {
    const count = await this.redis.zcard(requestsKey(endpointId));
    if (count > 0) await this.redis.del(requestsKey(endpointId), seqKey(endpointId));
    return count;
  }

  async pruneRequests(endpointId: string): Promise<void> {
    const count = await this.redis.zcard(requestsKey(endpointId));
    if (count > MAX_REQUESTS_PER_ENDPOINT) {
      await this.redis.zremrangebyrank(requestsKey(endpointId), 0, count - MAX_REQUESTS_PER_ENDPOINT - 1);
    }
  }

  async clearAll(): Promise<void> {
    const [endpointKeys, rKeys, sKeys] = await Promise.all([
      this.redis.keys("endpoint:*"),
      this.redis.keys("requests:*"),
      this.redis.keys("request_seq:*"),
    ]);
    const allKeys = [...endpointKeys, ...rKeys, ...sKeys];
    if (allKeys.length > 0) await this.redis.del(...allKeys);
  }
}
