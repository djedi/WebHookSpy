import { beforeEach, describe, expect, it } from "bun:test";
import { SqliteAdapter } from "./sqlite";

const makeAdapter = () => new SqliteAdapter(":memory:");

function makeRequestData(endpointId: string) {
  return {
    endpoint_id: endpointId,
    method: "POST",
    headers: JSON.stringify({ "content-type": "application/json" }),
    body: '{"test": true}',
    truncated: false,
    query: null,
    created_at: new Date().toISOString(),
    path: `/${endpointId}`,
    ip: "127.0.0.1",
  };
}

describe("SqliteAdapter", () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  describe("getEndpoint", () => {
    it("returns undefined for an unknown id", async () => {
      expect(await adapter.getEndpoint("nonexistent")).toBeUndefined();
    });

    it("returns the endpoint after creation", async () => {
      await adapter.createEndpoint("ep01", null);
      const found = await adapter.getEndpoint("ep01");
      expect(found?.id).toBe("ep01");
      expect(found?.password_hash).toBeNull();
    });
  });

  describe("createEndpoint", () => {
    it("stores the password hash", async () => {
      const ep = await adapter.createEndpoint("ep02", "bcrypt_hash");
      expect(ep.password_hash).toBe("bcrypt_hash");
    });

    it("sets expires_at approximately 7 days from now", async () => {
      const before = Date.now();
      const ep = await adapter.createEndpoint("ep03", null);
      const after = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const expiresAt = new Date(ep.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDays - 1000);
      expect(expiresAt).toBeLessThanOrEqual(after + sevenDays + 1000);
    });
  });

  describe("refreshExpiration", () => {
    it("pushes expires_at further into the future", async () => {
      const ep = await adapter.createEndpoint("ep04", null);
      const original = new Date(ep.expires_at).getTime();
      await new Promise((r) => setTimeout(r, 5));
      await adapter.refreshExpiration("ep04");
      const updated = await adapter.getEndpoint("ep04");
      expect(new Date(updated!.expires_at).getTime()).toBeGreaterThan(original);
    });
  });

  describe("deleteEndpoint", () => {
    it("removes the endpoint", async () => {
      await adapter.createEndpoint("ep05", null);
      await adapter.deleteEndpoint("ep05");
      expect(await adapter.getEndpoint("ep05")).toBeUndefined();
    });
  });

  describe("saveRequest", () => {
    it("returns auto-incrementing ids", async () => {
      await adapter.createEndpoint("ep06", null);
      const r1 = await adapter.saveRequest(makeRequestData("ep06"));
      const r2 = await adapter.saveRequest(makeRequestData("ep06"));
      expect(r1.id).toBeGreaterThan(0);
      expect(r2.id).toBeGreaterThan(r1.id);
    });

    it("stores truncated as 0 or 1", async () => {
      await adapter.createEndpoint("ep07", null);
      const trunc = await adapter.saveRequest({ ...makeRequestData("ep07"), truncated: true });
      const notTrunc = await adapter.saveRequest({ ...makeRequestData("ep07"), truncated: false });
      expect(trunc.truncated).toBe(1);
      expect(notTrunc.truncated).toBe(0);
    });
  });

  describe("getRequests", () => {
    it("returns requests newest-first", async () => {
      await adapter.createEndpoint("ep08", null);
      const r1 = await adapter.saveRequest(makeRequestData("ep08"));
      const r2 = await adapter.saveRequest(makeRequestData("ep08"));
      const r3 = await adapter.saveRequest(makeRequestData("ep08"));
      const results = await adapter.getRequests("ep08");
      expect(results[0].id).toBe(r3.id);
      expect(results[1].id).toBe(r2.id);
      expect(results[2].id).toBe(r1.id);
    });

    it("respects the limit parameter", async () => {
      await adapter.createEndpoint("ep09", null);
      for (let i = 0; i < 5; i++) await adapter.saveRequest(makeRequestData("ep09"));
      expect((await adapter.getRequests("ep09", 3)).length).toBe(3);
    });

    it("returns an empty array for an endpoint with no requests", async () => {
      await adapter.createEndpoint("ep10", null);
      expect(await adapter.getRequests("ep10")).toEqual([]);
    });
  });

  describe("getRequest", () => {
    it("returns the specific request by id", async () => {
      await adapter.createEndpoint("ep11", null);
      const saved = await adapter.saveRequest(makeRequestData("ep11"));
      const found = await adapter.getRequest("ep11", saved.id);
      expect(found?.id).toBe(saved.id);
    });

    it("returns undefined for a non-existent request id", async () => {
      await adapter.createEndpoint("ep12", null);
      expect(await adapter.getRequest("ep12", 99999)).toBeUndefined();
    });

    it("does not return a request belonging to a different endpoint", async () => {
      await adapter.createEndpoint("ep13a", null);
      await adapter.createEndpoint("ep13b", null);
      const saved = await adapter.saveRequest(makeRequestData("ep13a"));
      expect(await adapter.getRequest("ep13b", saved.id)).toBeUndefined();
    });
  });

  describe("deleteRequest", () => {
    it("removes the request and returns true", async () => {
      await adapter.createEndpoint("ep14", null);
      const saved = await adapter.saveRequest(makeRequestData("ep14"));
      expect(await adapter.deleteRequest("ep14", saved.id)).toBe(true);
      expect(await adapter.getRequest("ep14", saved.id)).toBeUndefined();
    });

    it("returns false for a non-existent request", async () => {
      await adapter.createEndpoint("ep15", null);
      expect(await adapter.deleteRequest("ep15", 99999)).toBe(false);
    });
  });

  describe("deleteRequests", () => {
    it("removes all requests and returns the count", async () => {
      await adapter.createEndpoint("ep16", null);
      for (let i = 0; i < 3; i++) await adapter.saveRequest(makeRequestData("ep16"));
      expect(await adapter.deleteRequests("ep16")).toBe(3);
      expect(await adapter.getRequests("ep16")).toEqual([]);
    });

    it("returns 0 when there are no requests", async () => {
      await adapter.createEndpoint("ep17", null);
      expect(await adapter.deleteRequests("ep17")).toBe(0);
    });
  });

  describe("pruneRequests", () => {
    it("removes the oldest requests when the count exceeds 100", async () => {
      await adapter.createEndpoint("ep18", null);
      const ids: number[] = [];
      for (let i = 0; i < 105; i++) {
        ids.push((await adapter.saveRequest(makeRequestData("ep18"))).id);
      }

      await adapter.pruneRequests("ep18");
      const remaining = await adapter.getRequests("ep18", 200);

      expect(remaining.length).toBe(100);
      // Oldest 5 pruned
      const remainingIds = new Set(remaining.map((r) => r.id));
      for (let i = 0; i < 5; i++) expect(remainingIds.has(ids[i])).toBe(false);
      // Newest 100 kept
      for (let i = 5; i < 105; i++) expect(remainingIds.has(ids[i])).toBe(true);
    });

    it("leaves requests untouched when under the limit", async () => {
      await adapter.createEndpoint("ep19", null);
      for (let i = 0; i < 5; i++) await adapter.saveRequest(makeRequestData("ep19"));
      await adapter.pruneRequests("ep19");
      expect((await adapter.getRequests("ep19")).length).toBe(5);
    });
  });

  describe("cleanupExpired", () => {
    it("does not throw when there is nothing to clean", async () => {
      await expect(adapter.cleanupExpired()).resolves.toBeUndefined();
    });

    it("removes endpoints whose expires_at is in the past", async () => {
      await adapter.createEndpoint("ep20", null);
      // Backdating via internal db — acceptable in a unit test for this adapter
      (adapter as any).db.run(
        "UPDATE endpoints SET expires_at = ? WHERE id = ?",
        new Date(0).toISOString(),
        "ep20"
      );

      await adapter.cleanupExpired();
      expect(await adapter.getEndpoint("ep20")).toBeUndefined();
    });

    it("does not remove endpoints that have not yet expired", async () => {
      await adapter.createEndpoint("ep21", null);
      await adapter.cleanupExpired();
      expect(await adapter.getEndpoint("ep21")).toBeDefined();
    });
  });

  describe("clearAll", () => {
    it("removes all endpoints and requests", async () => {
      await adapter.createEndpoint("ep22", null);
      await adapter.createEndpoint("ep23", null);
      await adapter.saveRequest(makeRequestData("ep22"));

      await adapter.clearAll();

      expect(await adapter.getEndpoint("ep22")).toBeUndefined();
      expect(await adapter.getEndpoint("ep23")).toBeUndefined();
      expect(await adapter.getRequests("ep22")).toEqual([]);
    });
  });
});
