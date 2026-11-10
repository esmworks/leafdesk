import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, localeDirection, type Locale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { DATABASE_VIEW_URI, SHOWN, TOTAL, type ViewSetup } from "@/lib/mcp-view";
import { savedLocale } from "@/server/mail/locale";
import { DATABASE_VIEW_SCRIPT, DATABASE_VIEW_STYLE } from "./app-bundle";

/**
 * The view that draws show_database's result in apps that show MCP Apps (Claude's apps among
 * them): one HTML page whose script (src/mcp-app/, bundled by scripts/mcp-app.ts into
 * app-bundle.ts) talks to the app through the MCP Apps SDK and draws the rows it is handed. The page
 * loads nothing from anywhere: rows are written by people, and the view only shows their text.
 */

/** Where Claude's apps serve the fonts their style variables name (applyHostFonts in the view). */
const HOST_FONTS = "https://assets.claude.ai";

/** The view as a resources/read content item, in `userId`'s language. */
export async function databaseViewResource(userId: string) {
  const locale = (await savedLocale(userId).catch(() => null)) ?? DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages: { database: messages.database }, namespace: "database" });
  const setup = {
    locale,
    texts: {
      name: t("nameColumn"),
      open: t("connectedView.open"),
      more: t("connectedView.more"),
      showing: t("connectedView.showing", { shown: SHOWN, total: TOTAL }),
      empty: t("connectedView.empty"),
      failed: t("connectedView.failed"),
      unavailable: t("connectedView.unavailable"),
      checked: t("connectedView.checked"),
      unchecked: t("connectedView.unchecked"),
      loading: t("connectedView.loading"),
    },
  } satisfies ViewSetup;
  return {
    uri: DATABASE_VIEW_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: databaseViewHtml(setup),
    // Drawn on the conversation's own background; the fonts are the app's (applyHostFonts).
    _meta: { ui: { prefersBorder: false, csp: { resourceDomains: [HOST_FONTS] } } },
  };
}

/** The view's page. Exported for tests. */
export function databaseViewHtml(setup: ViewSetup & { locale: Locale }): string {
  // JSON inside a script element ends at the first "</": write "<" as an escape.
  const json = JSON.stringify(setup).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    `<html lang="${setup.locale}" dir="${localeDirection(setup.locale)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<style>${DATABASE_VIEW_STYLE}</style>`,
    "</head>",
    "<body>",
    '<main id="view" aria-busy="true"></main>',
    `<script type="application/json" id="setup">${json}</script>`,
    `<script>${DATABASE_VIEW_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
