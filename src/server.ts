import type { Server } from "bun";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

type EndpointRow = {
  id: string;
  created_at: string;
  expires_at: string;
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const siteDir = path.join(projectRoot, "_site");
const endpointHtmlPath = path.join(siteDir, "endpoint", "index.html");
const indexHtmlPath = path.join(siteDir, "index.html");
const dataDir = path.join(projectRoot, "data");
const dbPath = path.join(dataDir, "webhookspy.sqlite");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run(
  `CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );`,
);
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
  );`,
);
db.run("CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint_id);");

const EXPIRATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days of inactivity
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REQUESTS_PER_ENDPOINT = 100;
const encoder = new TextEncoder();

type Subscriber = {
  send: (payload: string) => void;
  close: () => void;
};

const subscribers = new Map<string, Set<Subscriber>>();
let lastCleanup = 0;

function cleanupExpired() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) {
    return;
  }
  lastCleanup = now;
  const isoNow = new Date(now).toISOString();
  db.run("DELETE FROM requests WHERE endpoint_id IN (SELECT id FROM endpoints WHERE expires_at <= ?)", isoNow);
  db.run("DELETE FROM endpoints WHERE expires_at <= ?", isoNow);
}

function isValidEndpointId(id: string) {
  return /^[a-f0-9]{32}$/i.test(id);
}

function generateEndpointId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function getEndpoint(id: string): EndpointRow | undefined {
  const stmt = db.prepare<EndpointRow>("SELECT * FROM endpoints WHERE id = ? LIMIT 1");
  return stmt.get(id) as EndpointRow | undefined;
}

function createEndpoint(id = generateEndpointId()) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPIRATION_MS);
  db.run(
    "INSERT INTO endpoints (id, created_at, expires_at) VALUES (?, ?, ?)",
    id,
    now.toISOString(),
    expiresAt.toISOString(),
  );
  return getEndpoint(id)!;
}

function ensureEndpoint(id?: string) {
  const endpointId = id ?? generateEndpointId();
  let endpoint = getEndpoint(endpointId);
  if (!endpoint) {
    endpoint = createEndpoint(endpointId);
  }
  return endpoint;
}

function refreshEndpointExpiration(id: string) {
  const newExpiresAt = new Date(Date.now() + EXPIRATION_MS).toISOString();
  db.run("UPDATE endpoints SET expires_at = ? WHERE id = ?", newExpiresAt, id);
}

function pruneOldRequests(endpointId: string) {
  // Delete requests beyond the max limit, keeping only the newest ones
  db.run(
    `DELETE FROM requests WHERE endpoint_id = ? AND id NOT IN (
      SELECT id FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?
    )`,
    endpointId,
    endpointId,
    MAX_REQUESTS_PER_ENDPOINT,
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

function addSubscriber(endpointId: string, subscriber: Subscriber) {
  const set = subscribers.get(endpointId) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(endpointId, set);
}

function removeSubscriber(endpointId: string, subscriber: Subscriber) {
  const set = subscribers.get(endpointId);
  if (!set) return;
  set.delete(subscriber);
  if (!set.size) {
    subscribers.delete(endpointId);
  }
}

function broadcast(endpointId: string, payload: unknown) {
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

async function serveStaticFile(relativePath: string) {
  const filePath = path.join(siteDir, relativePath);
  if (!filePath.startsWith(siteDir)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handleWebhookCapture(req: Request, endpointId: string, server: Server) {
  const endpoint = ensureEndpoint(endpointId);
  const url = new URL(req.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const headers = Object.fromEntries(req.headers);
  const ipInfo = server.requestIP(req);
  const ip = ipInfo ? ipInfo.address : null;
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ip,
  );

  // Refresh expiration on activity and prune old requests
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
    ip,
  };
  broadcast(endpoint.id, { type: "request", request: mapRequest(row) });

  // Check if request is from a browser (has Accept header with text/html)
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

async function handleEndpointMetadata(endpointId: string) {
  const endpoint = getEndpoint(endpointId);
  if (!endpoint) {
    return new Response("Not found", { status: 404 });
  }
  const stmt = db.prepare<RequestRecord>(
    `SELECT * FROM requests WHERE endpoint_id = ? ORDER BY id DESC LIMIT 100`,
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

function handleSse(endpointId: string) {
  let subscriber: Subscriber | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      subscriber = {
        send,
        close: () => controller.close(),
      };
      addSubscriber(endpointId, subscriber);
      send(`event: ready\ndata: {}\n\n`);
      heartbeat = setInterval(() => {
        send(":keep-alive\n\n");
      }, 15_000);
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (subscriber) {
        removeSubscriber(endpointId, subscriber);
      }
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

async function serveInspectorPage(endpointId: string) {
  ensureEndpoint(endpointId);
  const file = Bun.file(endpointHtmlPath);
  if (!(await file.exists())) {
    return new Response("Inspector unavailable. Run `bun run build` first.", { status: 500 });
  }
  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveHomePage() {
  const file = Bun.file(indexHtmlPath);
  if (!(await file.exists())) {
    return new Response("Site not built. Run `bun run build`.", { status: 500 });
  }
  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveStaticPage(pagePath: string) {
  // Try exact path first (e.g., /og-image.html)
  let filePath = path.join(siteDir, pagePath);
  let file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Try as directory with index.html (e.g., /features/ -> /features/index.html)
  const cleanPath = pagePath.replace(/\/$/, "");
  filePath = path.join(siteDir, cleanPath, "index.html");
  file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8147),
  hostname: "0.0.0.0",
  fetch: async (req, bunServer) => {
    cleanupExpired();
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/") {
      return serveHomePage();
    }

    // Serve static assets
    if (pathname.startsWith("/assets/") || pathname === "/favicon.ico") {
      return serveStaticFile(pathname.slice(1));
    }

    // Serve robots.txt and sitemap.xml
    if (pathname === "/robots.txt" || pathname === "/sitemap.xml") {
      return serveStaticFile(pathname.slice(1));
    }

    // Serve inspector pages for valid endpoint IDs
    const inspectorMatch = pathname.match(/^\/inspect\/([a-f0-9]{32})$/i);
    if (inspectorMatch && req.method === "GET") {
      return serveInspectorPage(inspectorMatch[1]);
    }

    // API: Create endpoint
    if (pathname === "/api/endpoints" && req.method === "POST") {
      const endpoint = ensureEndpoint();
      return Response.json(endpoint);
    }

    // API: Get endpoint metadata
    const endpointMatch = pathname.match(/^\/api\/endpoints\/([a-f0-9]{32})$/i);
    if (endpointMatch && req.method === "GET") {
      return handleEndpointMetadata(endpointMatch[1]);
    }

    // API: SSE stream
    const streamMatch = pathname.match(/^\/api\/endpoints\/([a-f0-9]{32})\/stream$/i);
    if (streamMatch && req.method === "GET") {
      const endpointId = streamMatch[1];
      if (!getEndpoint(endpointId)) {
        return new Response("Not found", { status: 404 });
      }
      return handleSse(endpointId);
    }

    // Webhook capture for valid 32-char hex IDs
    const potentialEndpoint = pathname.slice(1).split("/")[0];
    if (potentialEndpoint && isValidEndpointId(potentialEndpoint)) {
      return handleWebhookCapture(req, potentialEndpoint, bunServer);
    }

    // Try to serve as a static page (e.g., /features/, /og-image.html)
    if (req.method === "GET") {
      const staticPage = await serveStaticPage(pathname);
      if (staticPage) {
        return staticPage;
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`WebhookSpy listening on http://0.0.0.0:${server.port}`);
