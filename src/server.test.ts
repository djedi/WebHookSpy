import type { Server } from "bun";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ACCESS_KEY_PREFIX,
  addSecurityHeaders,
  checkRateLimit,
  createApp,
  generateAccessKey,
  isValidEndpointId,
  rateLimitResponse,
  __test,
} from "./server";

const createTestClient = () => {
  const app = createApp();
  const request = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
  return { app, request };
};

describe("checkRateLimit", () => {
  it("blocks requests that exceed the limit", () => {
    const limiter = new Map<string, { count: number; resetTime: number }>();
    const ip = "127.0.0.1";
    const first = checkRateLimit(limiter, ip, 2);
    const second = checkRateLimit(limiter, ip, 2);
    const third = checkRateLimit(limiter, ip, 2);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.resetIn).toBeGreaterThan(0);
  });

  it("resets once the window has passed", () => {
    const limiter = new Map<string, { count: number; resetTime: number }>();
    const ip = "10.0.0.1";
    checkRateLimit(limiter, ip, 1);
    const state = limiter.get(ip);
    expect(state).toBeTruthy();
    if (state) {
      state.resetTime = Date.now() - 1;
    }

    const afterReset = checkRateLimit(limiter, ip, 1);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(0);
  });
});

describe("API routes via createServer", () => {
  let appRequest: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    ({ request: appRequest } = createTestClient());
  });

  beforeEach(() => {
    __test.resetState();
  });

  it("creates a public endpoint", async () => {
    const response = await appRequest("/api/endpoints", { method: "POST" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.id).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.protected).toBe(false);
    expect(payload.accessKey).toBeUndefined();
    expect(payload.created_at).toBeDefined();
    expect(payload.expires_at).toBeDefined();
  });

  it("creates a secure endpoint and returns an access key", async () => {
    const response = await appRequest("/api/endpoints?secure=true", { method: "POST" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.protected).toBe(true);
    expect(payload.accessKey).toMatch(new RegExp(`^${ACCESS_KEY_PREFIX}`));
  });

  it("returns endpoint metadata and captured requests", async () => {
    const { endpoint } = await __test.createEndpoint();
    await appRequest(`/${endpoint.id}?foo=bar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const response = await appRequest(`/api/endpoints/${endpoint.id}`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.id).toBe(endpoint.id);
    expect(Array.isArray(payload.requests)).toBe(true);
    expect(payload.requests[0].method).toBe("POST");
    expect(payload.requests[0].query.foo).toBe("bar");
  });

  it("rejects invalid endpoint ids before reaching the handler", async () => {
    const response = await appRequest("/api/endpoints/not-a-valid-id");
    expect(response.status).toBe(422);
  });

  it("returns 404 for unknown endpoints", async () => {
    const response = await appRequest("/api/endpoints/ffffffffffffffffffffffffffffffff");
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error).toContain("not found");
  });

  it("enforces access keys for protected endpoints", async () => {
    const { endpoint, accessKey } = await __test.createEndpoint({ secure: true });
    const missingKey = await appRequest(`/api/endpoints/${endpoint.id}`);
    expect(missingKey.status).toBe(401);

    const wrongKey = await appRequest(`/api/endpoints/${endpoint.id}?key=invalid`);
    expect(wrongKey.status).toBe(401);

    const withQueryKey = await appRequest(`/api/endpoints/${endpoint.id}?key=${accessKey}`);
    expect(withQueryKey.status).toBe(200);

    const withHeaderKey = await appRequest(`/api/endpoints/${endpoint.id}`, {
      headers: { "x-access-key": accessKey ?? "" },
    });
    expect(withHeaderKey.status).toBe(200);
  });

  it("reports protection status", async () => {
    const { endpoint: publicEndpoint } = await __test.createEndpoint();
    const { endpoint: secureEndpoint } = await __test.createEndpoint({ secure: true });

    const publicRes = await appRequest(`/api/endpoints/${publicEndpoint.id}/protected`);
    expect(publicRes.status).toBe(200);
    expect((await publicRes.json()).protected).toBe(false);

    const secureRes = await appRequest(`/api/endpoints/${secureEndpoint.id}/protected`);
    expect(secureRes.status).toBe(200);
    expect((await secureRes.json()).protected).toBe(true);
  });

  it("validates params for protection checks", async () => {
    const response = await appRequest("/api/endpoints/not-hex/protected");
    expect(response.status).toBe(422);
  });

  it("returns 404 for unknown ids on protection check", async () => {
    const response = await appRequest("/api/endpoints/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/protected");
    expect(response.status).toBe(404);
  });

  it("serves the homepage when the site is built", async () => {
    const response = await appRequest("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("serves the inspector page and creates the endpoint if missing", async () => {
    const endpointId = "1234567890abcdef1234567890abcdef";
    const response = await appRequest(`/inspect/${endpointId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const metadata = await __test.handleEndpointMetadata(endpointId);
    expect(metadata.status).toBe(200);
  });

  it("rejects invalid inspector endpoint ids", async () => {
    const response = await appRequest("/inspect/not-a-valid-id");
    expect(response.status).toBe(422);
  });

  it("rate limits endpoint creation after 10 requests per minute", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await appRequest("/api/endpoints", { method: "POST" });
      expect(res.status).toBe(200);
    }
    const blocked = await appRequest("/api/endpoints", { method: "POST" });
    expect(blocked.status).toBe(429);
    const payload = await blocked.json();
    expect(payload.error).toContain("Too many requests");
  });

  it("opens an SSE stream and emits the ready event", async () => {
    const { endpoint } = await __test.createEndpoint();
    const response = await appRequest(`/api/endpoints/${endpoint.id}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const chunk = await reader?.read();
    expect(chunk?.done).toBe(false);
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain("event: ready");
    await reader?.cancel();
  });

  it("requires valid access keys for SSE streams on protected endpoints", async () => {
    const { endpoint, accessKey } = await __test.createEndpoint({ secure: true });
    const missingKey = await appRequest(`/api/endpoints/${endpoint.id}/stream`);
    expect(missingKey.status).toBe(401);

    const wrongKey = await appRequest(`/api/endpoints/${endpoint.id}/stream?key=wrong`);
    expect(wrongKey.status).toBe(401);

    const withQueryKey = await appRequest(`/api/endpoints/${endpoint.id}/stream?key=${accessKey}`);
    expect(withQueryKey.status).toBe(200);
    await withQueryKey.body?.cancel();

    const withHeaderKey = await appRequest(`/api/endpoints/${endpoint.id}/stream`, {
      headers: { "x-access-key": accessKey ?? "" },
    });
    expect(withHeaderKey.status).toBe(200);
    await withHeaderKey.body?.cancel();
  });

  it("validates endpoint ids on the SSE route", async () => {
    const invalid = await appRequest("/api/endpoints/not-valid/stream");
    expect(invalid.status).toBe(422);

    const missing = await appRequest("/api/endpoints/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream");
    expect(missing.status).toBe(404);
  });

  it("deletes a single captured request", async () => {
    const { endpoint } = await __test.createEndpoint();
    await appRequest(`/${endpoint.id}`, { method: "POST", body: "test" });
    const metadataBefore = await __test.handleEndpointMetadata(endpoint.id);
    const beforePayload = await metadataBefore.json();
    expect(beforePayload.requests.length).toBe(1);
    const requestId = beforePayload.requests[0].id;

    const deleteResponse = await appRequest(`/api/endpoints/${endpoint.id}/requests/${requestId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);

    const metadataAfter = await __test.handleEndpointMetadata(endpoint.id);
    const afterPayload = await metadataAfter.json();
    expect(afterPayload.requests.length).toBe(0);
  });

  it("clears all requests for an endpoint", async () => {
    const { endpoint } = await __test.createEndpoint();
    await appRequest(`/${endpoint.id}`, { method: "POST", body: "first" });
    await appRequest(`/${endpoint.id}`, { method: "POST", body: "second" });

    const clearResponse = await appRequest(`/api/endpoints/${endpoint.id}/requests`, { method: "DELETE" });
    expect(clearResponse.status).toBe(200);
    const payload = await clearResponse.json();
    expect(payload.deleted).toBeGreaterThanOrEqual(2);

    const metadata = await __test.handleEndpointMetadata(endpoint.id);
    const metadataPayload = await metadata.json();
    expect(metadataPayload.requests.length).toBe(0);
  });

  it("deletes an endpoint and cascades requests", async () => {
    const { endpoint } = await __test.createEndpoint();
    await appRequest(`/${endpoint.id}`, { method: "POST", body: "payload" });

    const deleteResponse = await appRequest(`/api/endpoints/${endpoint.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);

    const metadata = await __test.handleEndpointMetadata(endpoint.id);
    expect(metadata.status).toBe(404);
  });

  it("requires access keys for destructive actions on protected endpoints", async () => {
    const { endpoint, accessKey } = await __test.createEndpoint({ secure: true });
    await appRequest(`/${endpoint.id}`, { method: "POST", body: "secret" });
    const metadataBefore = await __test.handleEndpointMetadata(endpoint.id);
    const beforePayload = await metadataBefore.json();
    const requestId = beforePayload.requests[0].id;

    const missingKey = await appRequest(`/api/endpoints/${endpoint.id}/requests/${requestId}`, { method: "DELETE" });
    expect(missingKey.status).toBe(401);

    const withKey = await appRequest(`/api/endpoints/${endpoint.id}/requests/${requestId}?key=${accessKey}`, {
      method: "DELETE",
    });
    expect(withKey.status).toBe(200);

    const deleteEndpointMissingKey = await appRequest(`/api/endpoints/${endpoint.id}`, { method: "DELETE" });
    expect(deleteEndpointMissingKey.status).toBe(401);

    const deleteEndpointWithKey = await appRequest(`/api/endpoints/${endpoint.id}?key=${accessKey}`, { method: "DELETE" });
    expect(deleteEndpointWithKey.status).toBe(200);
  });
});

describe("static asset routes", () => {
  let appRequest: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    ({ request: appRequest } = createTestClient());
  });

  beforeEach(() => {
    __test.resetState();
  });

  it("serves static assets from the built site", async () => {
    const response = await appRequest("/assets/logo.svg");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<svg");
  });

  it("returns 404 for missing assets", async () => {
    const response = await appRequest("/assets/not-found.svg");
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("Not found");
  });

  it("serves robots.txt and sitemap.xml when built", async () => {
    const robots = await appRequest("/robots.txt");
    expect(robots.status).toBe(200);
    expect((await robots.text()).length).toBeGreaterThan(0);

    const sitemap = await appRequest("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect((await sitemap.text()).length).toBeGreaterThan(0);
  });
});

describe("webhook capture routes", () => {
  let appRequest: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    ({ request: appRequest } = createTestClient());
  });

  beforeEach(() => {
    __test.resetState();
  });

  it("returns plain text for non-browser webhook captures", async () => {
    const { endpoint } = await __test.createEndpoint();
    const response = await appRequest(`/${endpoint.id}?foo=bar`, {
      headers: { "X-Demo": "true" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Captured");

    const metadataRes = await __test.handleEndpointMetadata(endpoint.id);
    const metadata = await metadataRes.json();
    expect(metadata.requests[0].headers["x-demo"]).toBe("true");
    expect(metadata.requests[0].query.foo).toBe("bar");
  });

  it("returns HTML capture page when Accept includes text/html", async () => {
    const { endpoint } = await __test.createEndpoint();
    const response = await appRequest(`/${endpoint.id}`, {
      headers: { Accept: "text/html" },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Request Captured");
  });

  it("captures subpaths and records the full request path", async () => {
    const { endpoint } = await __test.createEndpoint();
    await appRequest(`/${endpoint.id}/webhook/callback?hello=world`, {
      method: "POST",
    });
    const metadataRes = await __test.handleEndpointMetadata(endpoint.id);
    const metadata = await metadataRes.json();
    expect(metadata.requests[0].path).toBe(`/${endpoint.id}/webhook/callback?hello=world`);
  });

  it("truncates bodies over 512KB and marks the request as truncated", async () => {
    const { endpoint } = await __test.createEndpoint();
    const largeBody = "x".repeat(600 * 1024);
    const response = await appRequest(`/${endpoint.id}`, {
      method: "POST",
      body: largeBody,
    });
    expect(response.status).toBe(200);

    const metadataRes = await __test.handleEndpointMetadata(endpoint.id);
    const metadata = await metadataRes.json();
    expect(metadata.requests[0].truncated).toBe(true);
    expect(metadata.requests[0].body.length).toBe(512 * 1024);
  });

  it("rate limits webhook captures after 100 requests per minute", async () => {
    const { endpoint } = await __test.createEndpoint();
    for (let i = 0; i < 100; i++) {
      const res = await appRequest(`/${endpoint.id}`);
      expect(res.status).toBe(200);
    }
    const blocked = await appRequest(`/${endpoint.id}`);
    expect(blocked.status).toBe(429);
    const payload = await blocked.json();
    expect(payload.error).toContain("Too many requests");
  });
});

describe("rateLimitResponse", () => {
  it("returns a JSON 429 with retry header", async () => {
    const response = rateLimitResponse(4500);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const body = await response.json();
    expect(body.error).toContain("Too many requests");
  });
});

describe("addSecurityHeaders", () => {
  it("preserves existing headers and adds security defaults", () => {
    const base = new Response("ok", {
      headers: { "Content-Type": "application/json" },
    });
    const response = addSecurityHeaders(base);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src");
  });
});

describe("isValidEndpointId", () => {
  it("accepts 32-char hex IDs only", () => {
    expect(isValidEndpointId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidEndpointId("0123456789ABCDEf0123456789ABCDEF")).toBe(true);
    expect(isValidEndpointId("not-a-valid-id")).toBe(false);
    expect(isValidEndpointId("123")).toBe(false);
  });
});

describe("generateAccessKey", () => {
  it("prepends the required prefix and produces random values", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const key = generateAccessKey();
      expect(key.startsWith(ACCESS_KEY_PREFIX)).toBe(true);
      expect(key.length).toBeGreaterThan(ACCESS_KEY_PREFIX.length + 20);
      keys.add(key);
    }
    expect(keys.size).toBe(3);
  });
});

describe("Azure Event Grid validation handshake", () => {
  let appRequest: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    ({ request: appRequest } = createTestClient());
  });

  beforeEach(() => {
    __test.resetState();
  });

  it("responds with validationResponse for valid Event Grid validation event", async () => {
    const { endpoint } = await __test.createEndpoint();
    const body = JSON.stringify([
      {
        eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
        data: { validationCode: "test-code-123" },
      },
    ]);
    const response = await appRequest(`/${endpoint.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.validationResponse).toBe("test-code-123");
  });

  it("still captures the validation request in the database", async () => {
    const { endpoint } = await __test.createEndpoint();
    const body = JSON.stringify([
      {
        eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
        data: { validationCode: "abc-456" },
      },
    ]);
    await appRequest(`/${endpoint.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const metadataRes = await __test.handleEndpointMetadata(endpoint.id);
    const metadata = await metadataRes.json();
    expect(metadata.requests.length).toBe(1);
    expect(metadata.requests[0].method).toBe("POST");
    expect(metadata.requests[0].body).toContain("SubscriptionValidationEvent");
  });

  it("falls through to normal response for non-validation JSON", async () => {
    const { endpoint } = await __test.createEndpoint();
    const body = JSON.stringify({ eventType: "SomeOtherEvent", data: {} });
    const response = await appRequest(`/${endpoint.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Captured");
  });

  it("falls through to normal response for non-JSON body", async () => {
    const { endpoint } = await __test.createEndpoint();
    const response = await appRequest(`/${endpoint.id}`, {
      method: "POST",
      body: "plain text body",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Captured");
  });
});

describe("internal handlers", () => {
  it("captures webhook requests and exposes metadata", async () => {
    const endpoint = await __test.ensureEndpoint();
    const req = new Request(`http://localhost/${endpoint.id}?foo=bar`, {
      method: "POST",
      headers: { accept: "text/html", "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const mockServer = {
      requestIP() {
        return { address: "1.2.3.4" };
      },
    } as unknown as Server;
    const response = await __test.handleWebhookCapture(req, endpoint.id, mockServer);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const text = await response.text();
    expect(text).toContain("Request Captured");

    const metadataResponse = await __test.handleEndpointMetadata(endpoint.id);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json();
    expect(metadata.requests.some((entry: any) => entry.method === "POST" && entry.query.foo === "bar")).toBe(true);
  });

  it("returns 404 metadata for unknown endpoints", async () => {
    const unknown = await __test.handleEndpointMetadata("ffffffffffffffffffffffffffffffff");
    expect(unknown.status).toBe(404);
  });

  it("serveStaticPage returns null for unknown routes", async () => {
    const staticRes = await __test.serveStaticPage("/missing");
    expect(staticRes).toBeNull();
  });
});
