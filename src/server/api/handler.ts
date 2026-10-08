import type * as z from "zod";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { limitFromEnv, SlidingWindowLimiter } from "@/lib/rate-limit";
import { runAsConnectedApp } from "@/server/connected-app";
import { ApiError, apiErrorFor, errorBody } from "./errors";
import { matchRoute, type ApiRoute } from "./routes";
import type { ApiPrincipal, TokenCheck } from "./tokens";

/**
 * The REST API under /api/v1: personal access tokens (`Authorization: Bearer esi_…`), per-token
 * rate limits, JSON in and out, errors as `{error: {code, message, details?}}`.
 *
 * Only tokens authenticate here, never the browser's session cookie, so pages can't be made to call
 * the API on a signed-in user's behalf. Like MCP's OAuth tokens, requests a token authenticated are
 * outside the workspaces' sign-in policies (see sessionHold in access.ts), and answer to their
 * connected-apps setting instead (see connected-app.ts).
 */
export const API_PREFIX = "/api/v1";
/** Largest request body accepted. */
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
    "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining",
    ...(any ? {} : { Vary: "Origin" }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

const WWW_AUTHENTICATE = 'Bearer realm="leafdesk"';

function issues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", `Request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", `Request bodies can be at most ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
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
  return parsed;
}

/** Query parameters as an object; a repeated name keeps its last value. */
const queryObject = (url: URL) => Object.fromEntries(url.searchParams.entries());

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
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
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

    const limitHeaders: Record<string, string> = {};
    if (deps.limiter && deps.limiter.limit > 0) {
      const { limiter } = deps;
      const now = Date.now();
      const wait = limiter.retryAfter(principal.tokenId, now);
      limitHeaders["X-RateLimit-Limit"] = String(limiter.limit);
      if (wait > 0) {
        const error = new ApiError(429, "rate_limited", `Too many requests: at most ${limiter.limit} a minute per token.`);
        return json(429, errorBody(error), {
          ...cors,
          ...limitHeaders,
          "X-RateLimit-Remaining": "0",
          "Retry-After": String(Math.ceil(wait / 1000)),
        });
      }
      limiter.hit(principal.tokenId, now);
      limitHeaders["X-RateLimit-Remaining"] = String(Math.max(0, limiter.limit - limiter.count(principal.tokenId, now)));
    }
    const headers = { ...cors, ...limitHeaders };

    if (!principal.scopes.includes(route.scope)) {
      const error = new ApiError(403, "insufficient_scope", `This endpoint needs a token with the ${route.scope} scope.`);
      return json(403, errorBody(error), {
        ...headers,
        "WWW-Authenticate": `${WWW_AUTHENTICATE}, error="insufficient_scope", scope="${route.scope}"`,
      });
    }

    try {
      let query: Record<string, unknown> = {};
      if (route.query) {
        const parsed = route.query.safeParse(queryObject(url));
        if (!parsed.success) throw new ApiError(400, "validation_error", "Some query parameters are invalid.", issues(parsed.error));
        query = parsed.data;
      }
      let body: Record<string, unknown> = {};
      if (route.body) {
        const parsed = route.body.safeParse(await readBody(request));
        if (!parsed.success) throw new ApiError(400, "validation_error", "The request body is invalid.", issues(parsed.error));
        body = parsed.data;
      }
      const ctx = { userId: principal.userId, actor: { userId: principal.userId } };
      // Held to each workspace's connected-apps setting (see connected-app.ts): endpoints that
      // need pages:write are writes, refused where apps may only read. The token is named in the
      // audit log for what the endpoint changes (server/audit.ts).
      const app = {
        kind: "api_token" as const,
        id: principal.tokenId,
        ip: request.headers.get(CLIENT_IP_HEADER),
        userAgent: request.headers.get("user-agent"),
      };
      const result = await runAsConnectedApp({ userId: principal.userId, writing: route.scope === "pages:write", app }, () =>
        route.handler({ principal, ctx, params, query, body }),
      );
      return json(route.status ?? 200, result, headers);
    } catch (error) {
      const apiError = apiErrorFor(error);
      return json(apiError.status, errorBody(apiError), headers);
    }
  };
}
