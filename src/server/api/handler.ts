import { createHash } from "node:crypto";
import * as z from "zod";
import { isWriteScope } from "@/lib/api-scopes";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { limitFromEnv, SlidingWindowLimiter } from "@/lib/rate-limit";
import { runAsConnectedApp } from "@/server/connected-app";
import { BodyTooLargeError, readBodyLimited, readFormLimited } from "@/server/request-body";
import { ApiError, apiErrorFor, errorBody, missingScope } from "./errors";
import {
  IDEMPOTENCY_HEADER,
  keepsAnswer,
  MAX_IDEMPOTENCY_KEY,
  REPLAYED_HEADER,
  requestHashOf,
  type IdempotencyId,
  type IdempotencyStore,
} from "./idempotency";
import { matchRoute, type ApiRoute } from "./routes";
import type { ApiPrincipal, TokenCheck } from "./tokens";

/**
 * The REST API under /api/v1: personal access tokens (`Authorization: Bearer esi_…`) with scopes
 * per resource, per-token rate limits, idempotency keys for writes, JSON in and out (multipart form
 * data in where a route takes files), errors as `{error: {code, message, param?, details?}}`.
 *
 * Only tokens authenticate here, never the browser's session cookie, so pages can't be made to call
 * the API on a signed-in user's behalf. Like MCP's OAuth tokens, requests a token authenticated are
 * outside the workspaces' sign-in policies (see sessionHold in access.ts), and answer to their
 * connected-apps setting instead (see connected-app.ts).
 */
export const API_PREFIX = "/api/v1";
/** Largest JSON request body accepted (routes that take files set their own limit). */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Requests per token per minute when API_RATE_LIMIT isn't set. */
export const DEFAULT_RATE_LIMIT = 180;

export type ApiDeps = {
  routes: ApiRoute[];
  verifyToken: (secret: string) => Promise<TokenCheck>;
  /** Null turns rate limiting off. */
  limiter: SlidingWindowLimiter | null;
  openApiDocument: () => unknown;
  /** Origins allowed to call from a browser: "*", a list, or none (the default). */
  corsOrigins: string[];
  /** Where Idempotency-Key answers are kept; without one the header is ignored. */
  idempotency?: IdempotencyStore | null;
};

/** API_RATE_LIMIT: requests per token per minute; 0 turns the limit off. */
export function rateLimitFromEnv(value = process.env.API_RATE_LIMIT): number {
  return limitFromEnv(value, DEFAULT_RATE_LIMIT);
}

/** API_CORS_ORIGINS: comma-separated origins, or "*". Unset, browsers on other origins can't call the API. */
export function corsOriginsFromEnv(value = process.env.API_CORS_ORIGINS): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(deps: ApiDeps, request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !deps.corsOrigins.length) return {};
  const any = deps.corsOrigins.includes("*");
  if (!any && !deps.corsOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": any ? "*" : origin,
    "Access-Control-Expose-Headers": `Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, ${REPLAYED_HEADER}`,
    ...(any ? {} : { Vary: "Origin" }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return raw(status, JSON.stringify(body), headers);
}

/** An answer whose JSON is already written (a replayed one). */
function raw(status: number, text: string, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : text, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

const WWW_AUTHENTICATE = 'Bearer realm="leafdesk"';

/** A 400 listing what is wrong, `param` naming the first field (when the issue is about one). */
function validationError(message: string, error: z.ZodError) {
  const details = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const param = details.find((d) => d.path)?.path;
  return new ApiError(400, "validation_error", message, details, param ? { param } : {});
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = new TextDecoder().decode(await readBodyLimited(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new ApiError(413, "payload_too_large", `Request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
    }
    throw error;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Room for a form's text fields and boundaries on top of its files. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** A multipart request's text fields (to check like a JSON body) and files. */
async function readForm(request: Request, route: ApiRoute & { form: NonNullable<ApiRoute["form"]> }) {
  const maxBytes = route.form.maxBytes();
  const tooLarge = () => new ApiError(413, "payload_too_large", `The files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiError(415, "unsupported_media_type", "Send multipart/form-data.");
  }
  let form: FormData;
  try {
    form = await readFormLimited(request, maxBytes + FORM_OVERHEAD_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw tooLarge();
    throw new ApiError(400, "invalid_request", "The request body is not valid multipart form data.");
  }
  const fields: Record<string, string> = {};
  const files: Record<string, File> = {};
  let size = 0;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (value.trim()) fields[name] = value.trim();
    } else if (name in route.form.files) {
      files[name] = value;
      size += value.size;
    }
  }
  if (size > maxBytes) throw tooLarge();
  const missing = Object.entries(route.form.files).filter(([name, file]) => file.required && !files[name]);
  if (missing.length) {
    throw new ApiError(
      400,
      "validation_error",
      "The request body is invalid.",
      missing.map(([name]) => ({ path: name, message: "Send this file as a form field." })),
      { param: missing[0][0] },
    );
  }
  return { fields, files };
}

/** A form's files as an idempotency key's request hash takes them: by name, type, size and content. */
async function fileDigests(files: Record<string, File>) {
  const out: Record<string, { name: string; type: string; size: number; sha256: string }> = {};
  for (const [field, file] of Object.entries(files)) {
    const sha256 = createHash("sha256")
      .update(new Uint8Array(await file.arrayBuffer()))
      .digest("hex");
    out[field] = { name: file.name, type: file.type, size: file.size, sha256 };
  }
  return out;
}

/** Query parameters as an object; a repeated name keeps its last value. */
const queryObject = (url: URL) => Object.fromEntries(url.searchParams.entries());

/** Methods whose calls change something, and so take an Idempotency-Key (on routes with a write scope). */
const CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Whether a route's calls take an Idempotency-Key: those that change something (a query, a POST, doesn't). */
export const takesIdempotencyKey = (route: Pick<ApiRoute, "method" | "scope">) =>
  CHANGING_METHODS.has(route.method) && route.scope !== null && isWriteScope(route.scope);

/** The rate limit headers after a request was let through, or the answer when it is over the limit. */
function rateLimit(limiter: SlidingWindowLimiter | null, tokenId: string, cors: Record<string, string>) {
  if (!limiter || limiter.limit <= 0) return { headers: {} as Record<string, string>, refused: null };
  const now = Date.now();
  const wait = limiter.retryAfter(tokenId, now);
  const limit = { "X-RateLimit-Limit": String(limiter.limit) };
  if (wait > 0) {
    const error = new ApiError(429, "rate_limited", `Too many requests: at most ${limiter.limit} a minute per token.`);
    const refused = json(429, errorBody(error), {
      ...cors,
      ...limit,
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.ceil((now + wait) / 1000)),
      "Retry-After": String(Math.ceil(wait / 1000)),
    });
    return { headers: limit, refused };
  }
  limiter.hit(tokenId, now);
  return {
    headers: {
      ...limit,
      "X-RateLimit-Remaining": String(Math.max(0, limiter.limit - limiter.count(tokenId, now))),
      "X-RateLimit-Reset": String(Math.ceil(limiter.resetAt(tokenId, now) / 1000)),
    },
    refused: null,
  };
}

export function createApiHandler(deps: ApiDeps) {
  return async function handleApiRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : url.pathname;
    const cors = corsHeaders(deps, request);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) return new Response(null, { status: 204 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": `Authorization, Content-Type, ${IDEMPOTENCY_HEADER}`,
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (path === "/openapi.json") {
      if (method !== "GET" && method !== "HEAD") {
        return json(405, errorBody(new ApiError(405, "method_not_allowed", "Use GET.")), { ...cors, Allow: "GET" });
      }
      return json(200, deps.openApiDocument(), { ...cors, "Cache-Control": "public, max-age=300" });
    }

    const { route, params, allowed } = matchRoute(deps.routes, method, path);
    if (!route) {
      if (allowed.length) {
        const error = new ApiError(405, "method_not_allowed", `This endpoint takes ${allowed.join(", ")}.`);
        return json(405, errorBody(error), { ...cors, Allow: allowed.join(", ") });
      }
      return json(404, errorBody(new ApiError(404, "not_found", "There is no such endpoint. See /api/v1/openapi.json.")), cors);
    }

    const secret = bearer(request);
    if (!secret) {
      const error = new ApiError(401, "unauthorized", "Send a personal access token: Authorization: Bearer esi_…");
      return json(401, errorBody(error), { ...cors, "WWW-Authenticate": WWW_AUTHENTICATE });
    }
    let check: TokenCheck;
    try {
      check = await deps.verifyToken(secret);
    } catch (error) {
      const apiError = apiErrorFor(error);
      return json(apiError.status, errorBody(apiError), cors);
    }
    if (!check.ok) {
      const error =
        check.reason === "expired"
          ? new ApiError(401, "token_expired", "This token has expired. Create a new one in Settings.")
          : new ApiError(401, "invalid_token", "This token is not valid: it may be mistyped or revoked.");
      const description = check.reason === "expired" ? "The token expired" : "The token is not valid";
      return json(401, errorBody(error), {
        ...cors,
        "WWW-Authenticate": `${WWW_AUTHENTICATE}, error="invalid_token", error_description="${description}"`,
      });
    }
    const principal: ApiPrincipal = check.principal;

    const limited = rateLimit(deps.limiter, principal.tokenId, cors);
    if (limited.refused) return limited.refused;
    const headers = { ...cors, ...limited.headers };

    if (route.scope && !principal.scopes.includes(route.scope)) {
      return json(403, errorBody(missingScope(route.scope)), {
        ...headers,
        "WWW-Authenticate": `${WWW_AUTHENTICATE}, error="insufficient_scope", scope="${route.scope}"`,
      });
    }

    const store = takesIdempotencyKey(route) ? (deps.idempotency ?? null) : null;
    let claimed: IdempotencyId | null = null;
    /** Keeps the answer for retries with the key, or forgets the key when a retry should run again. */
    const settle = async (status: number, text: string, keep = keepsAnswer(status)) => {
      if (!store || !claimed) return;
      const id = claimed;
      claimed = null;
      try {
        if (keep) await store.complete(id, { status, body: text });
        else await store.release(id);
      } catch (error) {
        console.error("[api] could not keep an idempotency key's answer", error);
        await store.release(id).catch(() => {});
      }
    };

    try {
      const key = store ? request.headers.get(IDEMPOTENCY_HEADER) : null;
      if (key !== null && (!key.trim() || key.length > MAX_IDEMPOTENCY_KEY)) {
        throw new ApiError(400, "invalid_idempotency_key", `${IDEMPOTENCY_HEADER} must be 1 to ${MAX_IDEMPOTENCY_KEY} characters.`);
      }
      const rawQuery = queryObject(url);
      let query: Record<string, unknown> = {};
      if (route.query) {
        const parsed = route.query.safeParse(rawQuery);
        if (!parsed.success) throw validationError("Some query parameters are invalid.", parsed.error);
        query = parsed.data;
      }
      let body: Record<string, unknown> = {};
      let files: Record<string, File> = {};
      let sent: unknown = {};
      if (route.form) {
        const form = await readForm(request, { ...route, form: route.form });
        files = form.files;
        const parsed = (route.body ?? z.object({})).safeParse(form.fields);
        if (!parsed.success) throw validationError("The request body is invalid.", parsed.error);
        body = parsed.data;
        if (key !== null) sent = { fields: form.fields, files: await fileDigests(files) };
      } else if (route.body) {
        sent = await readBody(request);
        const parsed = route.body.safeParse(sent);
        if (!parsed.success) throw validationError("The request body is invalid.", parsed.error);
        body = parsed.data;
      }

      // Checked once the request is known to be valid: an invalid one changes nothing to replay.
      if (store && key !== null) {
        const id = { tokenId: principal.tokenId, operation: `${method} ${route.path}`, key };
        const claim = await store.claim({ ...id, requestHash: requestHashOf({ method, path, query: rawQuery, body: sent }) });
        if (claim.kind === "replay") return raw(claim.response.status, claim.response.body, { ...headers, [REPLAYED_HEADER]: "true" });
        if (claim.kind === "running") {
          const error = new ApiError(409, "idempotency_conflict", `A request with this ${IDEMPOTENCY_HEADER} is still running; send it again once it has finished.`);
          return json(409, errorBody(error), { ...headers, "Retry-After": "1" });
        }
        if (claim.kind === "reused") {
          const error = new ApiError(
            422,
            "idempotency_key_reused",
            `This ${IDEMPOTENCY_HEADER} was used for a different request (another path, query or body). Use a new key for each change.`,
          );
          return json(422, errorBody(error), headers);
        }
        claimed = id;
      }

      const ctx = { userId: principal.userId, actor: { userId: principal.userId } };
      // Held to each workspace's connected-apps setting (see connected-app.ts): endpoints that
      // need a write scope are writes, refused where apps may only read. The token is named in the
      // audit log for what the endpoint changes (server/audit.ts).
      const app = {
        kind: "api_token" as const,
        id: principal.tokenId,
        ip: request.headers.get(CLIENT_IP_HEADER),
        userAgent: request.headers.get("user-agent"),
      };
      const writing = route.scope !== null && isWriteScope(route.scope);
      const result = await runAsConnectedApp({ userId: principal.userId, writing, app }, () =>
        route.handler({ principal, ctx, params, query, body, files, signal: request.signal }),
      );
      const status = route.status ?? 200;
      const text = JSON.stringify(result);
      await settle(status, text);
      return raw(status, text, headers);
    } catch (error) {
      const apiError = apiErrorFor(error);
      const text = JSON.stringify(errorBody(apiError));
      // A missing scope can be granted to the token, and the retry should then run.
      await settle(apiError.status, text, keepsAnswer(apiError.status) && apiError.code !== "missing_scope");
      const retry: Record<string, string> = apiError.retryAfterSeconds ? { "Retry-After": String(apiError.retryAfterSeconds) } : {};
      return raw(apiError.status, text, { ...headers, ...retry });
    }
  };
}
