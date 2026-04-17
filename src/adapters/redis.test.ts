import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { RedisAdapter } from "./redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function tryConnect(): Promise<boolean> {
  try {
    const adapter = new RedisAdapter(REDIS_URL);
    await (adapter as any).redis.ping();
    await (adapter as any).redis.quit();
    return true;
  } catch {
    return false;
  }
}

describe("RedisAdapter", async () => {
  const available = await tryConnect();
  if (!available) {
    it.skip("Redis not available — skipping all Redis adapter tests", () => {});
    return;
  }

  let adapter: RedisAdapter;

  beforeAll(() => {
    adapter = new RedisAdapter(REDIS_URL);
  });

  afterAll(async () => {
    await adapter.clearAll();
    await (adapter as any).redis.quit();
  });

  beforeEach(async () => {
    await adapter.clearAll();
  });

  it("creates and retrieves an endpoint", async () => {
    const ep = await adapter.createEndpoint("redisep01", null);
    expect(ep.id).toBe("redisep01");
    expect(ep.password_hash).toBeNull();
    const fetched = await adapter.getEndpoint("redisep01");
    expect(fetched?.id).toBe("redisep01");
  });

  it("returns undefined for missing endpoint", async () => {
    const ep = await adapter.getEndpoint("nonexistent");
    expect(ep).toBeUndefined();
  });

  it("stores and retrieves requests in reverse order", async () => {
    await adapter.createEndpoint("redisep02", null);
    await adapter.saveRequest({ endpoint_id: "redisep02", method: "POST", headers: "{}", body: "a", truncated: false, query: null, created_at: new Date().toISOString(), path: "/", ip: null });
    await adapter.saveRequest({ endpoint_id: "redisep02", method: "GET", headers: "{}", body: null, truncated: false, query: null, created_at: new Date().toISOString(), path: "/", ip: null });
    const requests = await adapter.getRequests("redisep02");
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("GET");
    expect(requests[1].method).toBe("POST");
  });

  it("prunes requests above the limit", async () => {
    await adapter.createEndpoint("redisep03", null);
    for (let i = 0; i < 105; i++) {
      await adapter.saveRequest({ endpoint_id: "redisep03", method: "GET", headers: "{}", body: null, truncated: false, query: null, created_at: new Date().toISOString(), path: "/", ip: null });
    }
    await adapter.pruneRequests("redisep03");
    const requests = await adapter.getRequests("redisep03", 200);
    expect(requests.length).toBeLessThanOrEqual(100);
  });

  it("deletes a single request", async () => {
    await adapter.createEndpoint("redisep04", null);
    const req = await adapter.saveRequest({ endpoint_id: "redisep04", method: "DELETE", headers: "{}", body: null, truncated: false, query: null, created_at: new Date().toISOString(), path: "/", ip: null });
    const removed = await adapter.deleteRequest("redisep04", req.id);
    expect(removed).toBe(true);
    const fetched = await adapter.getRequest("redisep04", req.id);
    expect(fetched).toBeUndefined();
  });

  it("refreshes expiration without losing data", async () => {
    await adapter.createEndpoint("redisep05", null);
    await adapter.refreshExpiration("redisep05");
    const ep = await adapter.getEndpoint("redisep05");
    expect(ep?.id).toBe("redisep05");
  });

  it("deletes an endpoint and its requests", async () => {
    await adapter.createEndpoint("redisep06", null);
    await adapter.saveRequest({ endpoint_id: "redisep06", method: "POST", headers: "{}", body: null, truncated: false, query: null, created_at: new Date().toISOString(), path: "/", ip: null });
    await adapter.deleteEndpoint("redisep06");
    expect(await adapter.getEndpoint("redisep06")).toBeUndefined();
    expect(await adapter.getRequests("redisep06")).toHaveLength(0);
  });
});
