import path from "path";
import { fileURLToPath } from "url";

export const EXPIRATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const MAX_REQUESTS_PER_ENDPOINT = 100;

export type EndpointRow = {
  id: string;
  created_at: string;
  expires_at: string;
  password_hash: string | null;
};

export type RequestRecord = {
  id: number;
  endpoint_id: string;
  method: string;
  headers: string;
  body: string | null;
  truncated: number;
  query: string | null;
  created_at: string;
  path: string;
  ip: string | null;
};

export type NewRequestData = {
  endpoint_id: string;
  method: string;
  headers: string;
  body: string | null;
  truncated: boolean;
  query: string | null;
  created_at: string;
  path: string;
  ip: string | null;
};

export interface StorageAdapter {
  getEndpoint(id: string): Promise<EndpointRow | undefined>;
  createEndpoint(id: string, passwordHash: string | null): Promise<EndpointRow>;
  refreshExpiration(id: string): Promise<void>;
  deleteEndpoint(id: string): Promise<void>;
  cleanupExpired(): Promise<void>;
  saveRequest(data: NewRequestData): Promise<RequestRecord>;
  getRequests(endpointId: string, limit?: number): Promise<RequestRecord[]>;
  getRequest(endpointId: string, requestId: number): Promise<RequestRecord | undefined>;
  deleteRequest(endpointId: string, requestId: number): Promise<boolean>;
  deleteRequests(endpointId: string): Promise<number>;
  pruneRequests(endpointId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export async function createStorageAdapter(): Promise<StorageAdapter> {
  if (process.env.STORAGE_BACKEND === "redis") {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL env var is required when STORAGE_BACKEND=redis");
    const { RedisAdapter } = await import("./adapters/redis");
    return new RedisAdapter(redisUrl);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(__dirname, "..");
  const dbPath = path.join(projectRoot, "data", "webhookspy.sqlite");
  const { SqliteAdapter } = await import("./adapters/sqlite");
  return new SqliteAdapter(dbPath);
}
