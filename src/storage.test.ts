import { describe, expect, it } from "bun:test";
import { SqliteAdapter } from "./adapters/sqlite";
import { createStorageAdapter } from "./storage";

describe("createStorageAdapter", () => {
  it("throws a clear error when STORAGE_BACKEND=redis but REDIS_URL is absent", async () => {
    const prevBackend = process.env.STORAGE_BACKEND;
    const prevUrl = process.env.REDIS_URL;

    process.env.STORAGE_BACKEND = "redis";
    delete process.env.REDIS_URL;

    try {
      await expect(createStorageAdapter()).rejects.toThrow("REDIS_URL");
    } finally {
      if (prevBackend !== undefined) process.env.STORAGE_BACKEND = prevBackend;
      else delete process.env.STORAGE_BACKEND;
      if (prevUrl !== undefined) process.env.REDIS_URL = prevUrl;
    }
  });

  it("throws on unknown STORAGE_BACKEND value", async () => {
    const prev = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = "Reddis";
    try {
      await expect(createStorageAdapter()).rejects.toThrow("Unsupported STORAGE_BACKEND");
    } finally {
      if (prev !== undefined) process.env.STORAGE_BACKEND = prev;
      else delete process.env.STORAGE_BACKEND;
    }
  });

  it("returns a working SqliteAdapter by default", async () => {
    const adapter = new SqliteAdapter(":memory:");
    const ep = await adapter.createEndpoint("storagefactory01", null);
    expect(ep.id).toBe("storagefactory01");
    await adapter.clearAll();
  });
});
