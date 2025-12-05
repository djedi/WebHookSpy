import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// Types
type EndpointRow = {
  id: string;
  created_at: string;
  expires_at: string;
  password_hash: string | null;
};

type RequestRecord = {
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

type SerializableRequest = {
  id: number;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  truncated: boolean;
  query: Record<string, string>;
  createdAt: string;
  path: string;
  ip: string | null;
};

type Subscriber = {
  send: (payload: string) => void;
  close: () => void;
};

// Path setup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const siteDir = path.join(projectRoot, "_site");
const endpointHtmlPath = path.join(siteDir, "endpoint", "index.html");
const indexHtmlPath = path.join(siteDir, "index.html");
const dataDir = path.join(projectRoot, "data");
const dbPath = path.join(dataDir, "webhookspy.sqlite");

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database setup
const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run(
  `CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    password_hash TEXT
  );`
);
// Migration: add password_hash column if it doesn't exist
try {
  db.run("ALTER TABLE endpoints ADD COLUMN password_hash TEXT");
} catch {
  // Column already exists
}
db.run(
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
db.run("CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint_id);");

// Constants
const APP_VERSION = process.env.APP_VERSION ?? "dev";
const EXPIRATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REQUESTS_PER_ENDPOINT = 100;
const encoder = new TextEncoder();

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_ENDPOINT_CREATES = 10;
const RATE_LIMIT_MAX_REQUESTS = 100;

// Rate limiting stores
const endpointCreateLimiter = new Map<string, { count: number; resetTime: number }>();
const requestLimiter = new Map<string, { count: number; resetTime: number }>();

// SSE subscribers
const subscribers = new Map<string, Set<Subscriber>>();
let lastCleanup = 0;

// Security headers
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
};

// Access key constants
export const ACCESS_KEY_PREFIX = "whspy_";

// Utility functions
export function checkRateLimit(
  limiter: Map<string, { count: number; resetTime: number }>,
  ip: string,
  maxRequests: number
): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const record = limiter.get(ip);

  if (!record || now > record.resetTime) {
    limiter.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: maxRequests - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (record.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetIn: record.resetTime - now };
  }

  record.count++;
  return { allowed: true, remaining: maxRequests - record.count, resetIn: record.resetTime - now };
}

export function addSecurityHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export function rateLimitResponse(resetIn: number): Response {
  return new Response(JSON.stringify({ error: "Too many requests. Please slow down." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(resetIn / 1000)),
    },
  });
}

export function isValidEndpointId(id: string): boolean {
  return /^[a-f0-9]{32}$/i.test(id);
}

export function generateAccessKey(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return ACCESS_KEY_PREFIX + base64;
}

async function hashAccessKey(key: string): Promise<string> {
  return await Bun.password.hash(key);
}

async function verifyAccessKey(key: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(key, hash);
}

function isEndpointProtected(endpoint: EndpointRow): boolean {
  return endpoint.password_hash !== null;
}

function generateEndpointId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function getEndpoint(id: string): EndpointRow | undefined {
  const stmt = db.prepare<EndpointRow, string>("SELECT * FROM endpoints WHERE id = ? LIMIT 1");
  return stmt.get(id) as EndpointRow | undefined;
}

async function createEndpoint(
  id = generateEndpointId(),
  secure = false
): Promise<{ endpoint: EndpointRow; accessKey?: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPIRATION_MS);

  let passwordHash: string | null = null;
  let accessKey: string | undefined;

  if (secure) {
    accessKey = generateAccessKey();
    passwordHash = await hashAccessKey(accessKey);
  }

  db.run(
    "INSERT INTO endpoints (id, created_at, expires_at, password_hash) VALUES (?, ?, ?, ?)",
    id,
    now.toISOString(),
    expiresAt.toISOString(),
    passwordHash
  );

  return { endpoint: getEndpoint(id)!, accessKey };
}

async function ensureEndpoint(id?: string): Promise<EndpointRow> {
  const endpointId = id ?? generateEndpointId();
  let endpoint = getEndpoint(endpointId);
  if (!endpoint) {
    const result = await createEndpoint(endpointId, false);
    endpoint = result.endpoint;
  }
  return endpoint;
}

function refreshEndpointExpiration(id: string): void {
  const newExpiresAt = new Date(Date.now() + EXPIRATION_MS).toISOString();
  db.run("UPDATE endpoints SET expires_at = ? WHERE id = ?", newExpiresAt, id);
}

function pruneOldRequests(endpointId: string): void {
  db.run(
    `DELETE FROM requests WHERE endpoint_id = ? AND id NOT IN (
      SELECT id FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?
    )`,
    endpointId,
    endpointId,
    MAX_REQUESTS_PER_ENDPOINT
  );
}

function mapRequest(row: RequestRecord): SerializableRequest {
  return {
    id: row.id,
    method: row.method,
    headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : {},
    body: row.body,
    truncated: Boolean(row.truncated),
    query: row.query ? (JSON.parse(row.query) as Record<string, string>) : {},
    createdAt: row.created_at,
    path: row.path,
    ip: row.ip,
  };
}

function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  const isoNow = new Date(now).toISOString();
  db.run("DELETE FROM requests WHERE endpoint_id IN (SELECT id FROM endpoints WHERE expires_at <= ?)", isoNow);
  db.run("DELETE FROM endpoints WHERE expires_at <= ?", isoNow);
}

function addSubscriber(endpointId: string, subscriber: Subscriber): void {
  const set = subscribers.get(endpointId) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(endpointId, set);
}

function removeSubscriber(endpointId: string, subscriber: Subscriber): void {
  const set = subscribers.get(endpointId);
  if (!set) return;
  set.delete(subscriber);
  if (!set.size) subscribers.delete(endpointId);
}

function broadcast(endpointId: string, payload: unknown): void {
  const set = subscribers.get(endpointId);
  if (!set?.size) return;
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  for (const subscriber of set) {
    try {
      subscriber.send(body);
    } catch {
      subscriber.close();
      set.delete(subscriber);
    }
  }
}

function closeSubscribers(endpointId: string): void {
  const set = subscribers.get(endpointId);
  if (!set?.size) return;
  for (const subscriber of set) {
    try {
      subscriber.close();
    } catch {
      // Ignore closing errors
    }
  }
  subscribers.delete(endpointId);
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of endpointCreateLimiter) {
    if (now > record.resetTime) endpointCreateLimiter.delete(ip);
  }
  for (const [ip, record] of requestLimiter) {
    if (now > record.resetTime) requestLimiter.delete(ip);
  }
}, 60_000);

// Static file serving helpers
async function serveStaticFile(relativePath: string): Promise<Response | null> {
  const filePath = path.join(siteDir, relativePath);
  if (!filePath.startsWith(siteDir)) return null;
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return new Response(file);
  } catch {
    return null;
  }
}

async function serveStaticPage(pagePath: string): Promise<Response | null> {
  // Try exact path first
  let filePath = path.join(siteDir, pagePath);
  let file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Try as directory with index.html
  const cleanPath = pagePath.replace(/\/$/, "");
  filePath = path.join(siteDir, cleanPath, "index.html");
  file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return null;
}

// Handler functions
async function handleWebhookCapture(
  req: Request,
  endpointId: string,
  clientIp: string
): Promise<Response> {
  const endpoint = await ensureEndpoint(endpointId);
  const url = new URL(req.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const headers = Object.fromEntries(req.headers);
  const bodyBuffer = await req.arrayBuffer();
  let truncated = false;
  let limitedBuffer = bodyBuffer;
  if (bodyBuffer.byteLength > MAX_BODY_BYTES) {
    truncated = true;
    limitedBuffer = bodyBuffer.slice(0, MAX_BODY_BYTES);
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bodyText = limitedBuffer.byteLength ? decoder.decode(limitedBuffer) : null;
  const now = new Date().toISOString();

  const insert = db.prepare(
    `INSERT INTO requests (endpoint_id, method, headers, body, truncated, query, created_at, path, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    endpoint.id,
    req.method,
    JSON.stringify(headers),
    bodyText,
    truncated ? 1 : 0,
    Object.keys(query).length ? JSON.stringify(query) : null,
    now,
    url.pathname + url.search,
    clientIp
  );

  refreshEndpointExpiration(endpoint.id);
  pruneOldRequests(endpoint.id);

  const row: RequestRecord = {
    id: Number(result.lastInsertRowid),
    endpoint_id: endpoint.id,
    method: req.method,
    headers: JSON.stringify(headers),
    body: bodyText,
    truncated: truncated ? 1 : 0,
    query: Object.keys(query).length ? JSON.stringify(query) : null,
    created_at: now,
    path: url.pathname + url.search,
    ip: clientIp,
  };
  broadcast(endpoint.id, { type: "request", request: mapRequest(row) });

  // Check if request is from a browser
  const acceptHeader = headers["accept"] || "";
  if (acceptHeader.includes("text/html")) {
    const inspectorUrl = `/inspect/${endpoint.id}`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Request Captured - WebhookSpy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #1e293b; border-radius: 1rem; padding: 2rem; max-width: 480px; text-align: center; border: 1px solid #334155; }
    .icon { width: 64px; height: 64px; background: #14b8a6; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem; }
    .icon svg { width: 32px; height: 32px; color: white; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; color: #f8fafc; }
    p { color: #94a3b8; margin-bottom: 1.5rem; line-height: 1.6; }
    .method { display: inline-block; background: #0ea5e9; color: white; padding: 0.25rem 0.75rem; border-radius: 0.375rem; font-weight: 600; font-size: 0.875rem; margin-bottom: 1rem; }
    .details { background: #0f172a; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem; text-align: left; font-size: 0.875rem; }
    .details div { display: flex; justify-content: space-between; padding: 0.25rem 0; }
    .details span:first-child { color: #64748b; }
    .details span:last-child { color: #e2e8f0; font-family: monospace; }
    a.btn { display: inline-block; background: #14b8a6; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; text-decoration: none; font-weight: 500; transition: background 0.2s; }
    a.btn:hover { background: #0d9488; }
    .hint { font-size: 0.75rem; color: #64748b; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>
    <span class="method">${req.method}</span>
    <h1>Request Captured!</h1>
    <p>Your ${req.method} request has been recorded and is ready for inspection.</p>
    <div class="details">
      <div><span>Endpoint</span><span>${endpoint.id.slice(0, 8)}...</span></div>
      <div><span>Path</span><span>${url.pathname}</span></div>
      <div><span>Time</span><span>${new Date().toLocaleTimeString()}</span></div>
    </div>
    <a class="btn" href="${inspectorUrl}">View in Inspector</a>
    <p class="hint">Tip: Keep the inspector open to see requests stream in real-time</p>
  </div>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Captured", { status: 200 });
}

async function handleEndpointMetadata(endpointId: string): Promise<Response> {
  const endpoint = getEndpoint(endpointId);
  if (!endpoint) {
    return new Response("Not found", { status: 404 });
  }
  const stmt = db.prepare<RequestRecord, string>(
    `SELECT * FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT 100`
  );
  const rows = stmt.all(endpointId) as RequestRecord[];
  const payload = {
    id: endpoint.id,
    createdAt: endpoint.created_at,
    expiresAt: endpoint.expires_at,
    requests: rows.map(mapRequest),
  };
  return Response.json(payload);
}

function handleSse(endpointId: string): Response {
  let subscriber: Subscriber | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (subscriber) {
      removeSubscriber(endpointId, subscriber);
      subscriber = undefined;
    }
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      subscriber = {
        send,
        close: () => {
          cleanup();
          controller.close();
        },
      };
      addSubscriber(endpointId, subscriber);
      send(`event: ready\ndata: {}\n\n`);
      heartbeat = setInterval(() => {
        try {
          send(":keep-alive\n\n");
        } catch {
          cleanup();
        }
      }, 15_000);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Export test helpers
export const __test = {
  ensureEndpoint,
  createEndpoint: (options?: { id?: string; secure?: boolean }) => createEndpoint(options?.id, options?.secure ?? false),
  resetState: () => {
    db.run("DELETE FROM requests");
    db.run("DELETE FROM endpoints");
    endpointCreateLimiter.clear();
    requestLimiter.clear();
    subscribers.clear();
    lastCleanup = 0;
  },
  handleEndpointMetadata,
  handleWebhookCapture: (req: Request, endpointId: string, server: { requestIP: (req: Request) => { address: string } | null }) => {
    const ipInfo = server.requestIP(req);
    return handleWebhookCapture(req, endpointId, ipInfo?.address ?? "unknown");
  },
  serveHomePage: async () => {
    const file = Bun.file(indexHtmlPath);
    if (!(await file.exists())) {
      return new Response("Site not built. Run `bun run build`.", { status: 500 });
    }
    return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
  serveStaticPage,
  serveInspectorPage: async (endpointId: string) => {
    await ensureEndpoint(endpointId);
    const file = Bun.file(endpointHtmlPath);
    if (!(await file.exists())) {
      return new Response("Inspector unavailable. Run `bun run build` first.", { status: 500 });
    }
    return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

// Elysia app factory
export function createApp() {
  return new Elysia()
    // Swagger documentation
    .use(
      swagger({
        documentation: {
          info: {
            title: "WebhookSpy API",
            version: "1.0.0",
            description: "A webhook testing and inspection tool. Capture, inspect, and debug HTTP webhooks in real-time.",
            contact: {
              name: "WebhookSpy",
              url: "https://webhookspy.com",
            },
          },
          tags: [
            { name: "endpoints", description: "Endpoint management operations" },
            { name: "webhooks", description: "Webhook capture operations" },
          ],
          externalDocs: {
            description: "Back to WebhookSpy.com",
            url: "/",
          },
        },
        path: "/docs",
        exclude: ["/", "/inspect/*", "/assets/*", "/favicon.ico", "/robots.txt", "/sitemap.xml", /^\/[a-f0-9]{32}/],
        provider: "scalar",
        scalarConfig: {
          customCss: `
            .scalar-app { --scalar-background-1: #0f172a; }
            .light-mode .scalar-app { --scalar-background-1: #f8fafc; }
          `,
          metaData: {
            title: "WebhookSpy API Documentation",
            description: "API documentation for WebhookSpy - a free webhook testing tool",
            ogImage: "https://webhookspy.com/assets/og-image.png",
          },
          favicon: "/assets/favicon.svg",
        },
      })
    )
    // Run cleanup on each request
    .onRequest(() => {
      cleanupExpired();
    })
    // Add security headers to all responses
    .onAfterHandle(({ response, set }) => {
      // Skip security headers for SSE streams
      if (set.headers["Content-Type"] === "text/event-stream") return response;
      for (const [key, value] of Object.entries(securityHeaders)) {
        set.headers[key] = value;
      }
      return response;
    })
    // Derive client IP
    .derive(({ request, server }) => ({
      clientIp: server?.requestIP(request)?.address ?? "unknown",
    }))

    // === API Routes ===

    // Version endpoint
    .get("/api/version", () => ({ version: APP_VERSION }), {
      detail: {
        tags: ["system"],
        summary: "Get application version",
        description: "Returns the current application version.",
        responses: {
          200: { description: "Version information" },
        },
      },
    })

    // Create endpoint
    .post(
      "/api/endpoints",
      async ({ query, clientIp, set }) => {
        const rateCheck = checkRateLimit(endpointCreateLimiter, clientIp, RATE_LIMIT_MAX_ENDPOINT_CREATES);
        if (!rateCheck.allowed) {
          set.status = 429;
          set.headers["Retry-After"] = String(Math.ceil(rateCheck.resetIn / 1000));
          return { error: "Too many requests. Please slow down." };
        }
        const secure = query.secure === "true";
        const { endpoint, accessKey } = await createEndpoint(undefined, secure);
        return {
          id: endpoint.id,
          created_at: endpoint.created_at,
          expires_at: endpoint.expires_at,
          protected: isEndpointProtected(endpoint),
          accessKey,
        };
      },
      {
        query: t.Object({
          secure: t.Optional(t.String({ description: "Set to 'true' to create a protected endpoint" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Create a new webhook endpoint",
          description: "Creates a new webhook endpoint. Optionally create a protected endpoint with an access key.",
          responses: {
            200: { description: "Endpoint created successfully" },
            429: { description: "Rate limit exceeded" },
          },
        },
      }
    )

    // Get endpoint metadata
    .get(
      "/api/endpoints/:id",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        const stmt = db.prepare<RequestRecord, string>(
          `SELECT * FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT 100`
        );
        const rows = stmt.all(params.id) as RequestRecord[];
        return {
          id: endpoint.id,
          createdAt: endpoint.created_at,
          expiresAt: endpoint.expires_at,
          requests: rows.map(mapRequest),
        };
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Get endpoint metadata and captured requests",
          description: "Retrieves endpoint details and all captured webhook requests. Protected endpoints require an access key.",
          responses: {
            200: { description: "Endpoint metadata with captured requests" },
            400: { description: "Invalid endpoint ID format" },
            401: { description: "Access key required for protected endpoint" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // Get requests with filtering (for testing/integration)
    .get(
      "/api/endpoints/:id/requests",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        const stmt = db.prepare<RequestRecord, string>(
          `SELECT * FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT 100`
        );
        const rows = stmt.all(params.id) as RequestRecord[];
        let requests = rows.map(mapRequest);

        // Apply filters
        if (query.method) {
          requests = requests.filter((r) => r.method.toUpperCase() === query.method!.toUpperCase());
        }
        if (query.path) {
          requests = requests.filter((r) => r.path.includes(query.path!));
        }

        // Body text search (substring match anywhere in body)
        if (query.body) {
          requests = requests.filter((r) => r.body?.includes(query.body!) ?? false);
        }

        // Body JSON key filter - check if a key exists in parsed JSON body
        if (query.body_key) {
          requests = requests.filter((r) => {
            if (!r.body) return false;
            try {
              const parsed = JSON.parse(r.body);
              return query.body_key! in parsed;
            } catch {
              return false;
            }
          });
        }

        // Body JSON value filter - check if a key has a specific value (format: "key:value")
        if (query.body_value) {
          const colonIdx = query.body_value.indexOf(":");
          if (colonIdx > 0) {
            const key = query.body_value.slice(0, colonIdx);
            const value = query.body_value.slice(colonIdx + 1);
            requests = requests.filter((r) => {
              if (!r.body) return false;
              try {
                const parsed = JSON.parse(r.body);
                return String(parsed[key]) === value;
              } catch {
                return false;
              }
            });
          }
        }

        // Query param key filter - check if query param exists
        if (query.query_key) {
          requests = requests.filter((r) => query.query_key! in r.query);
        }

        // Query param value filter - check if query param has value (format: "key:value")
        if (query.query_value) {
          const colonIdx = query.query_value.indexOf(":");
          if (colonIdx > 0) {
            const key = query.query_value.slice(0, colonIdx);
            const value = query.query_value.slice(colonIdx + 1);
            requests = requests.filter((r) => r.query[key] === value);
          }
        }

        // Header key filter - check if header exists (case-insensitive)
        if (query.header_key) {
          requests = requests.filter((r) => {
            return Object.keys(r.headers).some(
              (k) => k.toLowerCase() === query.header_key!.toLowerCase()
            );
          });
        }

        // Header value filter - check header has value (format: "name:value", case-insensitive name)
        if (query.header_value) {
          const colonIdx = query.header_value.indexOf(":");
          if (colonIdx > 0) {
            const headerName = query.header_value.slice(0, colonIdx);
            const headerValue = query.header_value.slice(colonIdx + 1);
            requests = requests.filter((r) => {
              const headerKey = Object.keys(r.headers).find(
                (k) => k.toLowerCase() === headerName.toLowerCase()
              );
              if (!headerKey) return false;
              return r.headers[headerKey].includes(headerValue);
            });
          }
        }

        if (query.limit) {
          const limit = parseInt(query.limit, 10);
          if (!isNaN(limit) && limit > 0) {
            requests = requests.slice(0, limit);
          }
        }

        return requests;
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
          method: t.Optional(t.String({ description: "Filter by HTTP method (GET, POST, etc.)" })),
          path: t.Optional(t.String({ description: "Filter by path (substring match)" })),
          body: t.Optional(t.String({ description: "Filter by body text (substring match)" })),
          body_key: t.Optional(t.String({ description: "Filter by JSON body key existence" })),
          body_value: t.Optional(t.String({ description: "Filter by JSON body key:value (e.g., 'user_id:123')" })),
          query_key: t.Optional(t.String({ description: "Filter by query param key existence" })),
          query_value: t.Optional(t.String({ description: "Filter by query param key:value (e.g., 'rand:24052')" })),
          header_key: t.Optional(t.String({ description: "Filter by header key existence (case-insensitive)" })),
          header_value: t.Optional(t.String({ description: "Filter by header name:value (e.g., 'content-type:application/json')" })),
          limit: t.Optional(t.String({ description: "Limit number of results" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Get captured requests with filtering",
          description: "Returns captured webhook requests as JSON array. Supports filtering by method, path, body text/key/value, and header key/value. Useful for testing and CI/CD integration.",
          responses: {
            200: { description: "Array of captured requests" },
            400: { description: "Invalid endpoint ID format" },
            401: { description: "Access key required for protected endpoint" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // Check if endpoint is protected
    .get(
      "/api/endpoints/:id/protected",
      ({ params, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }
        return { protected: isEndpointProtected(endpoint) };
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Check if endpoint is protected",
          description: "Returns whether the endpoint requires an access key. This endpoint does not require authentication.",
          responses: {
            200: { description: "Protection status" },
            400: { description: "Invalid endpoint ID format" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // SSE stream for endpoint
    .get(
      "/api/endpoints/:id/stream",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        return handleSse(params.id);
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Subscribe to real-time webhook updates",
          description: "Opens a Server-Sent Events (SSE) stream for real-time webhook notifications. Protected endpoints require an access key.",
          responses: {
            200: { description: "SSE stream opened" },
            400: { description: "Invalid endpoint ID format" },
            401: { description: "Access key required for protected endpoint" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // Delete a single request
    .delete(
      "/api/endpoints/:id/requests/:requestId",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        const requestId = Number(params.requestId);
        const selectStmt = db.prepare("SELECT * FROM requests WHERE endpoint_id = ? AND id = ? LIMIT 1");
        const requestRow = selectStmt.get(endpoint.id, requestId) as RequestRecord | undefined;
        if (!requestRow) {
          set.status = 404;
          return { error: "Request not found" };
        }

        db.run("DELETE FROM requests WHERE endpoint_id = ? AND id = ?", endpoint.id, requestId);
        broadcast(endpoint.id, { type: "request_deleted", requestId });
        return { success: true };
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
          requestId: t.String({
            pattern: "^[0-9]+$",
            description: "Numeric request identifier",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Delete a single captured request",
          description: "Removes a captured webhook request. Protected endpoints require an access key.",
          responses: {
            200: { description: "Request deleted" },
            400: { description: "Invalid endpoint ID" },
            401: { description: "Access key required" },
            404: { description: "Endpoint or request not found" },
          },
        },
      }
    )

    // Delete all requests for an endpoint
    .delete(
      "/api/endpoints/:id/requests",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        const result = db.prepare("DELETE FROM requests WHERE endpoint_id = ?").run(endpoint.id);
        const deleted = Number(result.changes ?? 0);
        if (deleted > 0) {
          broadcast(endpoint.id, { type: "requests_cleared" });
        }
        return { success: true, deleted };
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Clear all captured requests",
          description: "Deletes all stored webhook requests for the endpoint. Protected endpoints require an access key.",
          responses: {
            200: { description: "Requests cleared" },
            400: { description: "Invalid endpoint ID" },
            401: { description: "Access key required" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // Delete an endpoint and all of its data
    .delete(
      "/api/endpoints/:id",
      async ({ params, query, headers, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return { error: "Invalid endpoint ID" };
        }
        const endpoint = getEndpoint(params.id);
        if (!endpoint) {
          set.status = 404;
          return { error: "Endpoint not found" };
        }

        if (isEndpointProtected(endpoint)) {
          const accessKey = query.key || headers["x-access-key"];
          if (!accessKey || !(await verifyAccessKey(accessKey, endpoint.password_hash!))) {
            set.status = 401;
            return { error: "Access key required", protected: true };
          }
        }

        db.run("DELETE FROM endpoints WHERE id = ?", endpoint.id);
        broadcast(endpoint.id, { type: "endpoint_deleted" });
        closeSubscribers(endpoint.id);
        return { success: true };
      },
      {
        params: t.Object({
          id: t.String({
            pattern: "^[a-f0-9]{32}$",
            description: "32-character hex endpoint ID",
          }),
        }),
        query: t.Object({
          key: t.Optional(t.String({ description: "Access key for protected endpoints" })),
        }),
        detail: {
          tags: ["endpoints"],
          summary: "Delete an endpoint",
          description: "Deletes the endpoint and all associated requests immediately. Protected endpoints require an access key.",
          responses: {
            200: { description: "Endpoint deleted" },
            400: { description: "Invalid endpoint ID" },
            401: { description: "Access key required" },
            404: { description: "Endpoint not found" },
          },
        },
      }
    )

    // === Static Routes ===

    // Home page
    .get("/", async ({ set }) => {
      const file = Bun.file(indexHtmlPath);
      if (!(await file.exists())) {
        set.status = 500;
        return "Site not built. Run `bun run build`.";
      }
      set.headers["Content-Type"] = "text/html; charset=utf-8";
      return file;
    })

    // Inspector page
    .get(
      "/inspect/:id",
      async ({ params, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 400;
          return "Invalid endpoint ID";
        }
        await ensureEndpoint(params.id);
        const file = Bun.file(endpointHtmlPath);
        if (!(await file.exists())) {
          set.status = 500;
          return "Inspector unavailable. Run `bun run build` first.";
        }
        set.headers["Content-Type"] = "text/html; charset=utf-8";
        return file;
      },
      {
        params: t.Object({
          id: t.String({ pattern: "^[a-f0-9]{32}$" }),
        }),
      }
    )

    // Static assets
    .get("/assets/*", async ({ params, set }) => {
      const relativePath = `assets/${(params as any)["*"]}`;
      const response = await serveStaticFile(relativePath);
      if (!response) {
        set.status = 404;
        return "Not found";
      }
      return response;
    })

    .get("/favicon.ico", async ({ set }) => {
      const response = await serveStaticFile("favicon.ico");
      if (!response) {
        set.status = 404;
        return "Not found";
      }
      return response;
    })

    .get("/robots.txt", async ({ set }) => {
      const response = await serveStaticFile("robots.txt");
      if (!response) {
        set.status = 404;
        return "Not found";
      }
      return response;
    })

    .get("/sitemap.xml", async ({ set }) => {
      const response = await serveStaticFile("sitemap.xml");
      if (!response) {
        set.status = 404;
        return "Not found";
      }
      return response;
    })

    // Webhook capture - matches 32-char hex IDs with optional path
    .all(
      "/:id",
      async ({ params, request, clientIp, set }) => {
        if (!isValidEndpointId(params.id)) {
          // Try static page fallback
          const url = new URL(request.url);
          const staticPage = await serveStaticPage(url.pathname);
          if (staticPage) {
            set.headers["Content-Type"] = "text/html; charset=utf-8";
            return staticPage;
          }
          set.status = 404;
          return "Not found";
        }

        const rateCheck = checkRateLimit(requestLimiter, clientIp, RATE_LIMIT_MAX_REQUESTS);
        if (!rateCheck.allowed) {
          set.status = 429;
          set.headers["Retry-After"] = String(Math.ceil(rateCheck.resetIn / 1000));
          return { error: "Too many requests. Please slow down." };
        }

        return handleWebhookCapture(request, params.id, clientIp);
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        detail: {
          tags: ["webhooks"],
          summary: "Capture a webhook request",
          description: "Captures any HTTP request sent to this endpoint. Supports all HTTP methods. Returns HTML if Accept header includes text/html, otherwise returns plain text.",
          responses: {
            200: { description: "Request captured successfully" },
            429: { description: "Rate limit exceeded" },
          },
        },
      }
    )

    // Webhook capture with subpath
    .all(
      "/:id/*",
      async ({ params, request, clientIp, set }) => {
        if (!isValidEndpointId(params.id)) {
          set.status = 404;
          return "Not found";
        }

        const rateCheck = checkRateLimit(requestLimiter, clientIp, RATE_LIMIT_MAX_REQUESTS);
        if (!rateCheck.allowed) {
          set.status = 429;
          set.headers["Retry-After"] = String(Math.ceil(rateCheck.resetIn / 1000));
          return { error: "Too many requests. Please slow down." };
        }

        return handleWebhookCapture(request, params.id, clientIp);
      },
      {
        params: t.Object({
          id: t.String(),
          "*": t.String(),
        }),
        detail: {
          hide: true, // Hide from OpenAPI docs to avoid exactMirror warning
        },
      }
    );
}

export function createServer(options: { port?: number } = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 8147);
  const app = createApp();
  return app.listen(port);
}

if (import.meta.main) {
  const server = createServer();
  console.log(`WebhookSpy listening on http://0.0.0.0:${server.server?.port}`);
  console.log(`Swagger docs available at http://localhost:${server.server?.port}/docs`);
}
