import { env } from "@/lib/env";
import { SlidingWindowLimiter } from "@/lib/rate-limit";
import { corsOriginsFromEnv, createApiHandler, rateLimitFromEnv } from "./handler";
import { databaseIdempotencyStore } from "./idempotency";
import { buildOpenApiDocument } from "./openapi";
import { API_ROUTES } from "./routes";
import { verifyApiToken } from "./tokens";

/** Version of the API described at /api/v1/openapi.json. */
export const API_VERSION = "1.0.0";

let document: unknown;
export const openApiDocument = () => (document ??= buildOpenApiDocument(API_ROUTES, { appUrl: env.appUrl, version: API_VERSION }));

const globalForApi = globalThis as unknown as { __leafdeskApiLimiter?: SlidingWindowLimiter | null };

function limiter() {
  if (globalForApi.__leafdeskApiLimiter === undefined) {
    const limit = rateLimitFromEnv();
    // One per process (dev reloads keep it), like the limits on public forms.
    globalForApi.__leafdeskApiLimiter = limit > 0 ? new SlidingWindowLimiter(limit, 60_000) : null;
  }
  return globalForApi.__leafdeskApiLimiter;
}

export const handleApiRequest = (request: Request) =>
  createApiHandler({
    routes: API_ROUTES,
    verifyToken: (secret) => verifyApiToken(secret),
    limiter: limiter(),
    openApiDocument,
    corsOrigins: corsOriginsFromEnv(),
    idempotency: databaseIdempotencyStore,
  })(request);
