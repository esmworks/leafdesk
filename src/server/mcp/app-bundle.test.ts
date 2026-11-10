import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { databaseViewHtml } from "./app-view";

vi.mock("@/db", () => ({ db: {} }));
import { DATABASE_VIEW_HASH, DATABASE_VIEW_SCRIPT, DATABASE_VIEW_SOURCES, DATABASE_VIEW_STYLE } from "./app-bundle";
import { optionPaletteCss, sourcesHash } from "./app-sources";

describe("show_database's view bundle", () => {
  it("is the one its sources make: run `pnpm tsx scripts/mcp-app.ts` after changing them", () => {
    expect(sourcesHash(DATABASE_VIEW_SOURCES)).toBe(DATABASE_VIEW_HASH);
  });

  it("carries Leafdesk's option colors as globals.css has them", () => {
    expect(DATABASE_VIEW_STYLE).toContain(optionPaletteCss(readFileSync("src/app/globals.css", "utf8")));
  });

  it("can't end its script element early", () => {
    expect(DATABASE_VIEW_SCRIPT).not.toMatch(/<\/script|<!--/i);
  });
});

describe("databaseViewHtml", () => {
  it("writes the setup so that no text in it ends its element", () => {
    const html = databaseViewHtml({
      locale: "ar",
      texts: { name: "</script><b>", open: "", more: "", showing: "", empty: "", failed: "", unavailable: "", checked: "", unchecked: "", loading: "" },
    });
    expect(html).toContain('<html lang="ar" dir="rtl">');
    const setup = /<script type="application\/json" id="setup">(.*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(setup).not.toContain("<");
    expect(JSON.parse(setup).texts.name).toBe("</script><b>");
  });
});
