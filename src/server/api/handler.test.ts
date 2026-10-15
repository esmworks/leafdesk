import * as z from "zod";
import { describe, expect, it, vi } from "vitest";
import { SlidingWindowLimiter } from "@/lib/rate-limit";
import { AccessError } from "@/server/access";
import { AiError } from "@/server/ai/errors";
import { ApiError } from "./errors";
import { ToolInputError } from "@/server/mcp/format";
import { corsOriginsFromEnv, createApiHandler, rateLimitFromEnv } from "./handler";
import { defineRoute, matchRoute, type ApiRoute } from "./routes";
import type { TokenCheck } from "./tokens";

vi.mock("@/db", () => ({ db: {} }));

const principal = (scopes: ("pages:read" | "pages:write")[], tokenId = "t1") => ({
  tokenId,
  userId: "u1",
  scopes,
  workspaceId: null,
  expiresAt: null,
});

const TOKENS: Record<string, TokenCheck> = {
  [`esi_${"r".repeat(40)}`]: { ok: true, principal: principal(["pages:read"]) },
  [`esi_${"w".repeat(40)}`]: { ok: true, principal: principal(["pages:read", "pages:write"], "t2") },
  [`esi_${"e".repeat(40)}`]: { ok: false, reason: "expired" },
};
const READ = `esi_${"r".repeat(40)}`;
const WRITE = `esi_${"w".repeat(40)}`;

const routes: ApiRoute[] = [
  defineRoute({
    method: "GET",
    path: "/things/{thing_id}",
    operationId: "getThing",
    tag: "Pages",
    summary: "",
    scope: "pages:read",
    query: z.object({ limit: z.coerce.number().int().min(1).max(5).default(2) }),
    response: "Page",
    handler: async ({ params, query, ctx }) => {
      if (params.thing_id === "hidden") throw new AccessError();
      if (params.thing_id === "bad") throw new ToolInputError("That can't be done.");
      if (params.thing_id === "boom") throw new Error("database exploded");
      return { id: params.thing_id, limit: query.limit, user: ctx.userId, note: "kept by the handler" };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/things",
    operationId: "createThing",
    tag: "Pages",
    summary: "",
    scope: "pages:write",
    body: z.object({ title: z.string().min(1) }),
    status: 201,
    response: "Page",
    handler: async ({ body }) => ({ created: body.title }),
  }),
  defineRoute({
    method: "POST",
    path: "/recordings",
    operationId: "createRecording",
    tag: "Pages",
    summary: "",
    scope: "pages:write",
    body: z.object({ label: z.string().max(5).optional() }),
    form: {
      files: { audio: { description: "", required: true } },
      maxBytes: () => {
        if (recordingsOff) throw new ApiError(409, "voice_notes_unavailable", "Off.");
        return 1024;
      },
    },
    status: 201,
    response: "Page",
    handler: async ({ body, files, signal }) => {
      if (body.label === "slow") throw new AiError("timeout", "The request took too long");
      if (body.label === "off") throw new AiError("disabled", "AI is off for this workspace");
      if (body.label === "busy") throw new AiError("rateLimited", "Too many AI requests; try again shortly", 4_200);
      if (body.label === "bad") throw new AiError("provider", 'Transcription endpoint answered 401: {"error":"Incorrect API key sk-proj-abcd"}');
      return { label: body.label ?? null, files: Object.keys(files), name: files.audio.name, size: files.audio.size, aborted: signal.aborted };
    },
  }),
];
let recordingsOff = false;

function handler(options: { limit?: number; cors?: string[] } = {}) {
  return createApiHandler({
    routes,
    verifyToken: async (secret) => TOKENS[secret] ?? { ok: false, reason: "invalid" },
    limiter: options.limit ? new SlidingWindowLimiter(options.limit, 60_000) : null,
    openApiDocument: () => ({ openapi: "3.1.0" }),
    corsOrigins: options.cors ?? [],
  });
}

const call = (
  h: ReturnType<typeof handler>,
  method: string,
  path: string,
  { token, body, headers = {} }: { token?: string; body?: string | FormData; headers?: Record<string, string> } = {},
) =>
  h(
    new Request(`http://app.test/api/v1${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body } : {}),
    }),
  );

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;

describe("REST API handler", () => {
  it("answers a valid call with JSON, the path parameters and parsed query", async () => {
    const res = await call(handler(), "GET", "/things/abc?limit=3", { token: READ });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "abc", limit: 3, user: "u1", note: "kept by the handler" });
  });

  it("uses the route's status for creations", async () => {
    const res = await call(handler(), "POST", "/things", { token: WRITE, body: JSON.stringify({ title: "x" }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: "x" });
  });

  it("requires a token, and says why one is turned away", async () => {
    const none = await call(handler(), "GET", "/things/abc");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await errorOf(none)).code).toBe("unauthorized");
    const invalid = await call(handler(), "GET", "/things/abc", { token: `esi_${"x".repeat(40)}` });
    expect([invalid.status, (await errorOf(invalid)).code]).toEqual([401, "invalid_token"]);
    const expired = await call(handler(), "GET", "/things/abc", { token: `esi_${"e".repeat(40)}` });
    expect([expired.status, (await errorOf(expired)).code]).toEqual([401, "token_expired"]);
  });

  it("ignores session cookies", async () => {
    const res = await call(handler(), "GET", "/things/abc", { headers: { cookie: "better-auth.session_token=abc" } });
    expect(res.status).toBe(401);
  });

  it("refuses writes to read-only tokens", async () => {
    const res = await call(handler(), "POST", "/things", { token: READ, body: JSON.stringify({ title: "x" }) });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("insufficient_scope");
    expect(res.headers.get("www-authenticate")).toContain('scope="pages:write"');
  });

  it("names unknown endpoints and wrong methods", async () => {
    const missing = await call(handler(), "GET", "/nothing", { token: READ });
    expect([missing.status, (await errorOf(missing)).code]).toEqual([404, "not_found"]);
    const wrong = await call(handler(), "DELETE", "/things/abc", { token: READ });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });

  it("validates query and body, listing what is wrong", async () => {
    const query = await call(handler(), "GET", "/things/abc?limit=9", { token: READ });
    const queryError = await errorOf(query);
    expect([query.status, queryError.code]).toEqual([400, "validation_error"]);
    expect(queryError.details).toEqual([expect.objectContaining({ path: "limit" })]);
    const body = await call(handler(), "POST", "/things", { token: WRITE, body: JSON.stringify({ title: "" }) });
    expect([body.status, (await errorOf(body)).code]).toEqual([400, "validation_error"]);
    const json = await call(handler(), "POST", "/things", { token: WRITE, body: "{nope" });
    expect([json.status, (await errorOf(json)).code]).toEqual([400, "invalid_json"]);
    const array = await call(handler(), "POST", "/things", { token: WRITE, body: "[]" });
    expect([array.status, (await errorOf(array)).code]).toEqual([400, "invalid_json"]);
  });

  it("refuses bodies over the size limit", async () => {
    const res = await call(handler(), "POST", "/things", { token: WRITE, body: JSON.stringify({ title: "x".repeat(6 * 1024 * 1024) }) });
    expect([res.status, (await errorOf(res)).code]).toEqual([413, "payload_too_large"]);
  });

  it("takes multipart form data on routes with files: fields checked like a body, files by name", async () => {
    const form = new FormData();
    form.set("label", "hi");
    form.set("audio", new File(["abc"], "a.webm", { type: "audio/webm" }));
    form.set("other", new File(["zz"], "b.txt"));
    const res = await call(handler(), "POST", "/recordings", { token: WRITE, body: form });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ label: "hi", files: ["audio"], name: "a.webm", size: 3, aborted: false });
  });

  it("refuses other bodies, missing files, bad fields and files over the route's limit", async () => {
    const json = await call(handler(), "POST", "/recordings", {
      token: WRITE,
      body: JSON.stringify({ label: "hi" }),
      headers: { "content-type": "application/json" },
    });
    expect([json.status, (await errorOf(json)).code]).toEqual([415, "unsupported_media_type"]);

    const noFile = new FormData();
    noFile.set("label", "hi");
    const missing = await call(handler(), "POST", "/recordings", { token: WRITE, body: noFile });
    const missingError = await errorOf(missing);
    expect([missing.status, missingError.code]).toEqual([400, "validation_error"]);
    expect(missingError.details).toEqual([expect.objectContaining({ path: "audio" })]);

    const badField = new FormData();
    badField.set("label", "far too long");
    badField.set("audio", new File(["abc"], "a.webm"));
    const bad = await call(handler(), "POST", "/recordings", { token: WRITE, body: badField });
    expect([bad.status, (await errorOf(bad)).details]).toEqual([400, [expect.objectContaining({ path: "label" })]]);

    const large = new FormData();
    large.set("audio", new File([new Uint8Array(2048)], "a.webm"));
    const tooLarge = await call(handler(), "POST", "/recordings", { token: WRITE, body: large });
    expect([tooLarge.status, (await errorOf(tooLarge)).code]).toEqual([413, "payload_too_large"]);
    const declared = await call(handler(), "POST", "/recordings", {
      token: WRITE,
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024) },
    });
    expect([declared.status, (await errorOf(declared)).code]).toEqual([413, "payload_too_large"]);
  });

  it("lets a route with files refuse before its body is read, after the token and scope are checked", async () => {
    recordingsOff = true;
    try {
      const form = new FormData();
      form.set("audio", new File(["abc"], "a.webm"));
      const off = await call(handler(), "POST", "/recordings", { token: WRITE, body: form });
      expect([off.status, (await errorOf(off)).code]).toEqual([409, "voice_notes_unavailable"]);
      const readOnly = await call(handler(), "POST", "/recordings", { token: READ, body: form });
      expect([readOnly.status, (await errorOf(readOnly)).code]).toEqual([403, "insufficient_scope"]);
    } finally {
      recordingsOff = false;
    }
  });

  it("maps AI failures to the API's codes", async () => {
    const send = (label: string) => {
      const form = new FormData();
      form.set("label", label);
      form.set("audio", new File(["abc"], "a.webm"));
      return call(handler(), "POST", "/recordings", { token: WRITE, body: form });
    };
    const slow = await send("slow");
    expect([slow.status, (await errorOf(slow)).code]).toEqual([502, "upstream_error"]);
    const off = await send("off");
    expect([off.status, await errorOf(off)]).toEqual([409, { code: "ai_unavailable", message: "AI is off for this workspace." }]);
    const busy = await send("busy");
    expect([busy.status, (await errorOf(busy)).code]).toEqual([429, "rate_limited"]);
    expect(busy.headers.get("retry-after")).toBe("5");
  });

  it("keeps the provider's own error text out of the answer", async () => {
    const form = new FormData();
    form.set("label", "bad");
    form.set("audio", new File(["abc"], "a.webm"));
    const res = await call(handler(), "POST", "/recordings", { token: WRITE, body: form });
    const error = await errorOf(res);
    expect([res.status, error.code]).toEqual([502, "upstream_error"]);
    expect(error.message).not.toMatch(/401|sk-proj|Incorrect/);
  });

  it("stops reading a chunked body without a length once it passes the limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 10_000) return controller.close();
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = await handler()(
      new Request("http://app.test/api/v1/things", {
        method: "POST",
        headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect([res.status, (await errorOf(res)).code]).toEqual([413, "payload_too_large"]);
    expect(pulled).toBeLessThan(5 * 1024 + 10);
  });

  it("maps domain errors and hides unexpected ones", async () => {
    const hidden = await call(handler(), "GET", "/things/hidden", { token: READ });
    expect([hidden.status, (await errorOf(hidden)).code]).toEqual([404, "not_found"]);
    const bad = await call(handler(), "GET", "/things/bad", { token: READ });
    expect([bad.status, await errorOf(bad)]).toEqual([400, { code: "invalid_request", message: "That can't be done." }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = await call(handler(), "GET", "/things/boom", { token: READ });
    log.mockRestore();
    const error = await errorOf(boom);
    expect([boom.status, error.code]).toEqual([500, "internal_error"]);
    expect(error.message).not.toContain("exploded");
  });

  it("limits requests per token and says when to come back", async () => {
    const h = handler({ limit: 2 });
    const first = await call(h, "GET", "/things/a", { token: READ });
    expect(first.headers.get("x-ratelimit-limit")).toBe("2");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    await call(h, "GET", "/things/a", { token: READ });
    const limited = await call(h, "GET", "/things/a", { token: READ });
    expect([limited.status, (await errorOf(limited)).code]).toEqual([429, "rate_limited"]);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another token has its own allowance.
    expect((await call(h, "GET", "/things/a", { token: WRITE })).status).toBe(200);
  });

  it("serves the OpenAPI document without a token", async () => {
    const res = await call(handler(), "GET", "/openapi.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openapi: "3.1.0" });
  });

  it("sends no CORS headers unless origins are configured", async () => {
    const origin = { origin: "https://tools.example" };
    const off = await call(handler(), "GET", "/things/a", { token: READ, headers: origin });
    expect(off.headers.get("access-control-allow-origin")).toBeNull();
    const preflightOff = await call(handler(), "OPTIONS", "/things/a", { headers: origin });
    expect(preflightOff.headers.get("access-control-allow-origin")).toBeNull();

    const on = handler({ cors: ["https://tools.example"] });
    const allowed = await call(on, "GET", "/things/a", { token: READ, headers: origin });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://tools.example");
    const preflight = await call(on, "OPTIONS", "/things/a", { headers: origin });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    const other = await call(on, "GET", "/things/a", { token: READ, headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("settings from the environment", () => {
  it("reads the rate limit, falling back to the default", () => {
    expect(rateLimitFromEnv(undefined)).toBe(180);
    expect(rateLimitFromEnv("60")).toBe(60);
    expect(rateLimitFromEnv("0")).toBe(0);
    expect(rateLimitFromEnv("lots")).toBe(180);
  });

  it("reads CORS origins", () => {
    expect(corsOriginsFromEnv(undefined)).toEqual([]);
    expect(corsOriginsFromEnv(" https://a.example/ , https://b.example")).toEqual(["https://a.example", "https://b.example"]);
    expect(corsOriginsFromEnv("*")).toEqual(["*"]);
  });
});

describe("matchRoute", () => {
  it("matches templates, decodes parameters and lists other methods", () => {
    expect(matchRoute(routes, "GET", "/things/a%20b").params).toEqual({ thing_id: "a b" });
    expect(matchRoute(routes, "POST", "/things/a").allowed).toEqual(["GET"]);
    expect(matchRoute(routes, "GET", "/things/a/b").route).toBeNull();
    expect(matchRoute(routes, "GET", "/things/%E0%A4%A").route).toBeNull();
  });
});
