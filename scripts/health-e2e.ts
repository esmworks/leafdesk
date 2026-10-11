/**
 * Checks the health endpoints against a running app with its migrations applied:
 * - /api/health answers 200 `{"status":"ok"}`, never cached, without setting a cookie, to GET and
 *   HEAD, signed out and with a stale session cookie alike;
 * - /api/health/ready answers 200 `{"status":"ok"}` the same way;
 * - neither is held back by sign-in (no redirect, no 401) or by the API's rate limits.
 *
 * Its 503 answers (database unreachable, migrations pending) are covered by src/server/health.test.ts.
 *
 *   APP_URL=http://localhost:3313 pnpm tsx scripts/health-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000, read from .env when present). Needs no database access of its own.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const APP = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function probe(path: string, init: RequestInit = {}) {
  const res = await fetch(`${APP}${path}`, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

for (const path of ["/api/health", "/api/health/ready"]) {
  const res = await probe(path);
  check(res.status === 200, `${path}: 200`, res);
  check(res.body === `{"status":"ok"}`, `${path}: says only that it is ok`, res.body);
  check(res.headers.get("cache-control") === "no-store", `${path}: not cached`, res.headers.get("cache-control"));
  check(res.headers.get("content-type")?.startsWith("application/json"), `${path}: JSON`);
  check(!res.headers.has("set-cookie"), `${path}: sets no cookie`);

  const head = await probe(path, { method: "HEAD" });
  check(head.status === 200 && head.body === "", `${path}: HEAD 200 without a body`, head);

  // A browser's leftover session cookie is ignored, not answered with a sign-in redirect.
  const stale = await probe(path, { headers: { cookie: "better-auth.session_token=stale.token" } });
  check(stale.status === 200, `${path}: a stale session cookie changes nothing`, stale);
  check(!stale.headers.has("set-cookie"), `${path}: and isn't cleared either`);

  // Probes come every few seconds from one address: a burst well past any per-minute limit.
  const burst = await Promise.all(Array.from({ length: 150 }, () => probe(path)));
  check(
    burst.every((r) => r.status === 200),
    `${path}: 150 probes at once all answer 200`,
    burst.filter((r) => r.status !== 200).map((r) => r.status),
  );
}

console.log(`\n${passed} checks passed`);
