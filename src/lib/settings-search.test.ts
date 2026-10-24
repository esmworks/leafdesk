import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchSettings, SETTINGS_SEARCH_ENTRIES, type SettingsSearchItem } from "./settings-search";
import { ACCOUNT_SETTINGS_TABS, SETTINGS_TABS } from "./settings-tabs";

const src = fileURLToPath(new URL("..", import.meta.url));
const english = (namespace: string) => JSON.parse(readFileSync(join(src, "i18n/messages/en", `${namespace}.json`), "utf8"));
const text = (key: string) => {
  const [namespace, path] = key.split(":");
  return path.split(".").reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), english(namespace));
};

/** Every .tsx file under src/app and src/components, read once. */
const sources = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx")) out.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(src, "app"));
  walk(join(src, "components"));
  return out.join("\n");
})();

describe("the settings search entries", () => {
  it("have unique ids on tabs that exist", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tabs: readonly string[] = [...SETTINGS_TABS, ...ACCOUNT_SETTINGS_TABS];
    for (const entry of SETTINGS_SEARCH_ENTRIES) expect(tabs, entry.id).toContain(entry.tab);
  });

  it("cover every tab", () => {
    const covered = new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.tab));
    for (const tab of [...SETTINGS_TABS, ...ACCOUNT_SETTINGS_TABS]) expect(covered.has(tab), tab).toBe(true);
  });

  it("name English texts that exist", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.label) expect(typeof text(entry.label), entry.label).toBe("string");
      if (entry.keywords) expect(typeof text(`settings:search.keywords.${entry.id}`), entry.id).toBe("string");
    }
  });

  it("point at a setting the page marks", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES.filter((e) => e.label)) {
      const marked = sources.includes(`anchor="${entry.id}"`) || sources.includes(`settingAnchor("${entry.id}")`);
      expect(marked, `${entry.id}: give its SettingsGroup or SettingsRow anchor="${entry.id}"`).toBe(true);
    }
  });
});

describe("matchSettings", () => {
  const item = (id: string, label: string, tab: string, keywords = ""): SettingsSearchItem => ({ id, href: `/${id}`, label, tab, keywords });
  const items = [
    item("retention", "Data retention", "Security", "trash history delete"),
    item("legalHolds", "Legal holds", "Security", "litigation preserve"),
    item("language", "Language", "Preferences"),
    item("theme", "Appearance", "Preferences", "dark light"),
  ];
  const ids = (query: string) => matchSettings(items, query).map((i) => i.id);

  it("finds settings by name, tab and other words", () => {
    expect(ids("legal")).toEqual(["legalHolds"]);
    expect(ids("dark")).toEqual(["theme"]);
    expect(ids("security")).toEqual(["retention", "legalHolds"]);
    expect(ids("trash security")).toEqual(["retention"]);
    expect(ids("")).toEqual([]);
    expect(ids("nothing")).toEqual([]);
  });

  it("puts names that start with the words first", () => {
    expect(ids("l")).toEqual(["legalHolds", "language", "retention", "theme"]);
  });

  it("ignores case and the Turkish dotted i", () => {
    expect(ids("LEGAL")).toEqual(["legalHolds"]);
    expect(matchSettings([item("i", "İçe aktar", "Genel")], "içe").map((i) => i.id)).toEqual(["i"]);
  });
});
