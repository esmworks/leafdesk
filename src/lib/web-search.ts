/**
 * The server's web search service (WEB_SEARCH_PROVIDER, WEB_SEARCH_URL, WEB_SEARCH_API_KEY), for
 * agents with web access and, where owners turn it on, the AI chat (server/agents/web.ts). Off
 * unless set; see docs/ai.md.
 *
 * - `searxng`: a self-hosted SearXNG at WEB_SEARCH_URL with its JSON output on; the provider when
 *   only WEB_SEARCH_URL is set.
 * - `brave`: the Brave Search API, with WEB_SEARCH_API_KEY.
 * - `tavily`: the Tavily search API, with WEB_SEARCH_API_KEY.
 *
 * WEB_SEARCH_URL overrides the hosted services' address too (a proxy, a test server).
 */

export const WEB_SEARCH_PROVIDERS = ["searxng", "brave", "tavily"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export type WebSearchConfig = { provider: WebSearchProvider; url: string; apiKey: string | null };

const HOSTED_URLS: Record<Exclude<WebSearchProvider, "searxng">, string> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
};

/** The search service `env` sets up, or null when it sets up none (or one that can't work). */
export function webSearchFrom(env: Record<string, string | undefined>): WebSearchConfig | null {
  const url = env.WEB_SEARCH_URL?.trim() || null;
  const apiKey = env.WEB_SEARCH_API_KEY?.trim() || null;
  const named = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase() || null;
  const provider = named ?? (url ? "searxng" : null);
  if (!provider || !(WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (provider === "searxng") return url ? { provider, url, apiKey } : null;
  const hosted = provider as Exclude<WebSearchProvider, "searxng">;
  return apiKey ? { provider: hosted, url: url ?? HOSTED_URLS[hosted], apiKey } : null;
}
