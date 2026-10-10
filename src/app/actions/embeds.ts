"use server";

import { getTranslations } from "next-intl/server";
import { CSV_MAX_COLUMNS, CSV_MAX_ROWS } from "@/lib/import/csv";
import { ImportError } from "@/lib/import/result";
import { isDatabaseErrorCode } from "@/lib/properties";
import { AccessError } from "@/server/access";
import * as embeds from "@/server/embeds";
import { requireUserId } from "@/server/session";
import { databaseSeedNames } from "./seed-names";

export type EmbedActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The database behind a new inline database block, created under the page being edited. */
export async function createInlineDatabaseAction(hostPageId: string): Promise<EmbedActionResult<{ id: string }>> {
  const userId = await requireUserId();
  try {
    const created = await embeds.createInlineDatabase({ userId }, hostPageId, await databaseSeedNames());
    return { ok: true, data: { id: created.id } };
  } catch (error) {
    const t = await getTranslations();
    const code = (error as { code?: unknown }).code;
    if (isDatabaseErrorCode(code)) return { ok: false, error: t(`database.errors.${code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error("[embed action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** The database a table block turns into, made from its cells under the page being edited. */
export async function tableToDatabaseAction(hostPageId: string, records: string[][]): Promise<EmbedActionResult<{ id: string }>> {
  const userId = await requireUserId();
  try {
    if (!Array.isArray(records) || !records.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
      throw new ImportError("A table is rows of text cells", "badRequest");
    }
    const created = await embeds.tableToDatabase({ userId }, hostPageId, records, await databaseSeedNames());
    return { ok: true, data: { id: created.id } };
  } catch (error) {
    const t = await getTranslations();
    const code = (error as { code?: unknown }).code;
    if (error instanceof ImportError && (code === "tooManyRows" || code === "tooManyColumns")) {
      return { ok: false, error: t("page.embed.tableTooLarge", { rows: CSV_MAX_ROWS, columns: CSV_MAX_COLUMNS }) };
    }
    if (isDatabaseErrorCode(code)) return { ok: false, error: t(`database.errors.${code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    if (!(error instanceof ImportError)) console.error("[embed action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** What a database block may show; the same answer for missing and hidden databases. */
export async function embedInfoAction(databaseId: string): Promise<embeds.EmbedInfo> {
  const userId = await requireUserId();
  return embeds.getEmbedInfo(userId, databaseId);
}
