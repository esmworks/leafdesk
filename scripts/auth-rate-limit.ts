/**
 * Production builds rate limit sign-up and sign-in (3 per 10 s per IP, rolling), and in CI the e2e
 * scripts sign up and in one after another from one address. After this, `fetch` waits out a 429
 * from the app's auth routes (its X-Retry-After) instead of returning it; every other request goes
 * through as before. Bodies must be strings (they are sent again).
 */
export function waitOutAuthRateLimits(base: string) {
  const plain = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/api/auth/`)) return plain(input, init);
    for (let attempt = 1; ; attempt++) {
      const res = await plain(input, init);
      if (res.status !== 429 || attempt > 5) return res;
      const retryAfter = Number(res.headers.get("x-retry-after") ?? res.headers.get("retry-after") ?? 0);
      console.log(`  … sign-up and sign-in are rate limited, waiting ${retryAfter || 10} s`);
      await new Promise((resolve) => setTimeout(resolve, (retryAfter || 10) * 1000 + 250));
    }
  };
}
