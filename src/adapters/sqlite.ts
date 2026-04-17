import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import type { StorageAdapter, EndpointRow, RequestRecord, NewRequestData } from "../storage";
import { EXPIRATION_MS, MAX_REQUESTS_PER_ENDPOINT } from "../storage";

export class SqliteAdapter implements StorageAdapter {
  private db: Database;

  constructor(dbPath: string) {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        password_hash TEXT
      );`
    );
    try {
      this.db.run("ALTER TABLE endpoints ADD COLUMN password_hash TEXT");
    } catch {
      // Column already exists
    }
    this.db.run(
      `CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_id TEXT NOT NULL,
        method TEXT NOT NULL,
        headers TEXT NOT NULL,
        body TEXT,
        truncated INTEGER DEFAULT 0,
        query TEXT,
        created_at TEXT NOT NULL,
        path TEXT NOT NULL,
        ip TEXT,
        FOREIGN KEY(endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
      );`
    );
    this.db.run("CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint_id);");
  }

  async getEndpoint(id: string): Promise<EndpointRow | undefined> {
    const stmt = this.db.prepare<EndpointRow, string>("SELECT * FROM endpoints WHERE id = ? LIMIT 1");
    return (stmt.get(id) as EndpointRow | null) ?? undefined;
  }

  async createEndpoint(id: string, passwordHash: string | null): Promise<EndpointRow> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_MS);
    this.db.run(
      "INSERT INTO endpoints (id, created_at, expires_at, password_hash) VALUES (?, ?, ?, ?)",
      id,
      now.toISOString(),
      expiresAt.toISOString(),
      passwordHash
    );
    return (await this.getEndpoint(id))!;
  }

  async refreshExpiration(id: string): Promise<void> {
    const newExpiresAt = new Date(Date.now() + EXPIRATION_MS).toISOString();
    this.db.run("UPDATE endpoints SET expires_at = ? WHERE id = ?", newExpiresAt, id);
  }

  async deleteEndpoint(id: string): Promise<void> {
    this.db.run("DELETE FROM endpoints WHERE id = ?", id);
  }

  async cleanupExpired(): Promise<void> {
    const isoNow = new Date().toISOString();
    this.db.run(
      "DELETE FROM requests WHERE endpoint_id IN (SELECT id FROM endpoints WHERE expires_at <= ?)",
      isoNow
    );
    this.db.run("DELETE FROM endpoints WHERE expires_at <= ?", isoNow);
  }

  async saveRequest(data: NewRequestData): Promise<RequestRecord> {
    const stmt = this.db.prepare(
      `INSERT INTO requests (endpoint_id, method, headers, body, truncated, query, created_at, path, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      data.endpoint_id,
      data.method,
      data.headers,
      data.body,
      data.truncated ? 1 : 0,
      data.query,
      data.created_at,
      data.path,
      data.ip
    );
    return {
      id: Number(result.lastInsertRowid),
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
  }

  async getRequests(endpointId: string, limit = 100): Promise<RequestRecord[]> {
    const stmt = this.db.prepare<RequestRecord, [string, number]>(
      `SELECT * FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?`
    );
    return stmt.all(endpointId, limit) as RequestRecord[];
  }

  async getRequest(endpointId: string, requestId: number): Promise<RequestRecord | undefined> {
    const stmt = this.db.prepare<RequestRecord, [string, number]>(
      "SELECT * FROM requests WHERE endpoint_id = ? AND id = ? LIMIT 1"
    );
    return (stmt.get(endpointId, requestId) as RequestRecord | null) ?? undefined;
  }

  async deleteRequest(endpointId: string, requestId: number): Promise<boolean> {
    const result = this.db.run(
      "DELETE FROM requests WHERE endpoint_id = ? AND id = ?",
      endpointId,
      requestId
    );
    return Number(result.changes) > 0;
  }

  async deleteRequests(endpointId: string): Promise<number> {
    const result = this.db.prepare("DELETE FROM requests WHERE endpoint_id = ?").run(endpointId);
    return Number(result.changes ?? 0);
  }

  async pruneRequests(endpointId: string): Promise<void> {
    this.db.run(
      `DELETE FROM requests WHERE endpoint_id = ? AND id NOT IN (
        SELECT id FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?
      )`,
      endpointId,
      endpointId,
      MAX_REQUESTS_PER_ENDPOINT
    );
  }

  async clearAll(): Promise<void> {
    this.db.run("DELETE FROM requests");
    this.db.run("DELETE FROM endpoints");
  }
}
