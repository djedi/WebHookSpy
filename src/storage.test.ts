import { describe, expect, it } from "bun:test";
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

  it("returns a working SqliteAdapter by default", async () => {
    const prevBackend = process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_BACKEND;

    try {
      const adapter = await createStorageAdapter();
      const ep = await adapter.createEndpoint("storagefactory01", null);
      expect(ep.id).toBe("storagefactory01");
      await adapter.clearAll();
    } finally {
      if (prevBackend !== undefined) process.env.STORAGE_BACKEND = prevBackend;
      else delete process.env.STORAGE_BACKEND;
    }
  });
});
