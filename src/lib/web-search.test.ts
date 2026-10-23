import { describe, expect, it } from "vitest";
import { webSearchFrom } from "./web-search";

describe("webSearchFrom", () => {
  it("is off unless the server sets a service up", () => {
    expect(webSearchFrom({})).toBeNull();
    expect(webSearchFrom({ WEB_SEARCH_API_KEY: "k" })).toBeNull();
    expect(webSearchFrom({ WEB_SEARCH_PROVIDER: "bing", WEB_SEARCH_URL: "http://x" })).toBeNull();
  });

  it("takes a SearXNG at WEB_SEARCH_URL, the default with only an address", () => {
    expect(webSearchFrom({ WEB_SEARCH_URL: " http://searxng:8080 " })).toEqual({ provider: "searxng", url: "http://searxng:8080", apiKey: null });
    expect(webSearchFrom({ WEB_SEARCH_PROVIDER: "SearXNG" })).toBeNull();
  });

  it("needs a key for the hosted services, and lets WEB_SEARCH_URL point elsewhere", () => {
    expect(webSearchFrom({ WEB_SEARCH_PROVIDER: "brave" })).toBeNull();
    expect(webSearchFrom({ WEB_SEARCH_PROVIDER: "Brave", WEB_SEARCH_API_KEY: "b" })).toEqual({
      provider: "brave",
      url: "https://api.search.brave.com/res/v1/web/search",
      apiKey: "b",
    });
    expect(webSearchFrom({ WEB_SEARCH_PROVIDER: "tavily", WEB_SEARCH_API_KEY: "t", WEB_SEARCH_URL: "http://127.0.0.1:9/search" })).toEqual({
      provider: "tavily",
      url: "http://127.0.0.1:9/search",
      apiKey: "t",
    });
  });
});
