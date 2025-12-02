import type { Server } from "bun";
import { describe, expect, it } from "bun:test";
import {
  ACCESS_KEY_PREFIX,
  addSecurityHeaders,
  checkRateLimit,
  generateAccessKey,
  isValidEndpointId,
  rateLimitResponse,
  __test,
} from "./server";

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
