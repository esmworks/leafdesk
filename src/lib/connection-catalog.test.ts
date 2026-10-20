import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConnectionUrl } from "@/server/connections/fetch";
import { CATALOG_CATEGORIES, catalogEntryFor, catalogLogo, CONNECTION_CATALOG, instanceClientKey, searchCatalog } from "./connection-catalog";
import { connectionSlug, MAX_CONNECTION_NAME } from "./connections";

describe("connection catalog", () => {
  it("has unique ids, names and addresses", () => {
    for (const key of ["id", "name", "url"] as const) {
      const values = CONNECTION_CATALOG.map((entry) => entry[key].toLowerCase());
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it("lists addresses as a saved connection keeps them, and as the server accepts them", () => {
    for (const entry of CONNECTION_CATALOG) {
      expect(entry.url, entry.name).toBe(new URL(entry.url).href);
      expect(checkConnectionUrl(entry.url).href, entry.name).toBe(entry.url);
      expect(entry.url.startsWith("https://"), entry.name).toBe(true);
    }
  });

  it("gives every entry a name a connection takes, and a slug of its own", () => {
    for (const entry of CONNECTION_CATALOG) {
      expect(entry.name.length).toBeLessThanOrEqual(MAX_CONNECTION_NAME);
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(connectionSlug(entry.name, new Set())).not.toBe("conn");
    }
  });

  it("has entries in every category, and the token help only on token entries", () => {
    for (const category of CATALOG_CATEGORIES) expect(CONNECTION_CATALOG.some((entry) => entry.category === category), category).toBe(true);
    for (const entry of CONNECTION_CATALOG.filter((e) => e.tokenHelp)) {
      expect(entry.authType).toBe("token");
      expect(entry.tokenHelp).toMatch(/^https:\/\//);
    }
  });

  it("asks for an app only on OAuth entries, made at an https address", () => {
    const withApp = CONNECTION_CATALOG.filter((entry) => entry.client);
    expect(withApp.length).toBeGreaterThan(0);
    for (const entry of withApp) {
      expect(entry.authType, entry.name).toBe("oauth");
      expect(entry.client!.help, entry.name).toMatch(/^https:\/\//);
    }
    expect(CONNECTION_CATALOG.find((entry) => entry.id === "slack")).toMatchObject({ authType: "oauth", eventPreset: "slack", client: { help: "https://api.slack.com/apps" } });
    expect(CONNECTION_CATALOG.find((entry) => entry.id === "discord")?.client?.secretOptional).toBe(true);
  });

  it("signs in Google's services as one app, asking each for only its own scopes", () => {
    const google = CONNECTION_CATALOG.filter((entry) => new URL(entry.url).host.endsWith(".googleapis.com"));
    expect(google.map((entry) => entry.id).sort()).toEqual(
      ["gmail", "google-calendar", "google-chat", "google-contacts", "google-docs", "google-drive", "google-sheets", "google-slides"],
    );
    for (const entry of google) {
      expect(entry, entry.name).toMatchObject({ authType: "oauth", client: { shared: "google" } });
      expect(instanceClientKey(entry)).toBe("google");
      expect(entry.scope, entry.name).toMatch(/^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+( https:\/\/www\.googleapis\.com\/auth\/[a-z.]+)*$/);
      // Never the whole mailbox or all of Drive.
      expect(entry.scope!.split(" "), entry.name).not.toContain("https://mail.google.com/");
      expect(entry.scope!.split(" "), entry.name).not.toContain("https://www.googleapis.com/auth/drive");
    }
    expect(instanceClientKey(CONNECTION_CATALOG.find((entry) => entry.id === "slack")!)).toBe("slack");
  });

  it("has a logo for every entry, and no logo of a service it no longer lists", () => {
    // Only the logos: a folder browsed in a file manager may also hold its own files (.DS_Store).
    const files = readdirSync(join(process.cwd(), "public", "connections"))
      .filter((file) => file.endsWith(".png"))
      .sort();
    expect(files).toEqual(CONNECTION_CATALOG.map((entry) => catalogLogo(entry).replace("/connections/", "")).sort());
  });

  it("signs GitHub's events as GitHub does", () => {
    expect(CONNECTION_CATALOG.find((entry) => entry.id === "github")).toMatchObject({ authType: "token", eventPreset: "github" });
  });

  it("finds the entry of a saved connection whatever its trailing slash or host case", () => {
    expect(catalogEntryFor("https://mcp.linear.app/mcp")?.id).toBe("linear");
    expect(catalogEntryFor("https://MCP.Linear.app/mcp/")?.id).toBe("linear");
    expect(catalogEntryFor("https://mcp.stripe.com")?.id).toBe("stripe");
    expect(catalogEntryFor("https://mcp.linear.app/other")).toBeUndefined();
    expect(catalogEntryFor("not a url")).toBeUndefined();
  });

  it("searches names, hosts and category labels, every word", () => {
    const label = (category: string) => (category === "finance" ? "Finance & payments" : category);
    expect(searchCatalog("", label)).toHaveLength(CONNECTION_CATALOG.length);
    expect(searchCatalog("  linear ", label).map((e) => e.id)).toEqual(["linear"]);
    expect(searchCatalog("payments stripe", label).map((e) => e.id)).toEqual(["stripe"]);
    expect(searchCatalog("todoist.net", label).map((e) => e.id)).toEqual(["todoist"]);
    expect(searchCatalog("no such service at all", label)).toEqual([]);
  });
});
