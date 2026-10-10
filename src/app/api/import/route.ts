import { databaseSeedNames } from "@/app/actions/seed-names";
import { auth } from "@/lib/auth";
import { CSV_COLUMN_TYPES, type CsvColumnType } from "@/lib/import/csv";
import { cleanTitle, IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { spreadsheetTable } from "@/lib/import/xlsx";
import { PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { isCrossSite } from "@/server/cross-site";
import { importCsvAsDatabase, importCsvIntoDatabase, recordImport, type ColumnTarget } from "@/server/import/csv";
import { importPages } from "@/server/import/markdown";
import { TeamspaceError } from "@/server/teamspaces";

/**
 * Imports files: `POST /api/import` with a multipart form, answered with an ImportResult (see
 * lib/import/result) or `{ error, code, params }`.
 *
 *   mode=pages      Markdown and CSV files, and ZIPs of them, as pages under `parentId` (or the top
 *                   level of `workspaceId`). Each `file` may have a `path` (its place in a folder).
 *                   `vault=1`: the files are an Obsidian vault whose `.obsidian` folder wasn't sent.
 *   mode=csv-new    One CSV or Excel (.xlsx) `file` as a new database under `parentId` /
 *                   `workspaceId`, called `title`, with `titleColumn` (a column index, or empty for
 *                   none) and `types` (JSON: a property type or null per column; guessed when missing).
 *   mode=csv-merge  One CSV or Excel `file`'s rows added to the database `databaseId`; `mapping`
 *                   (JSON) says where each column goes: "title", a property id, or null.
 *
 * A workbook's sheet is `sheet` (an index into its visible worksheets); without it the first one is
 * imported and the others are reported as left out.
 *
 * Requests need the `X-Leafdesk-Import` header: a cross-site form can't send it, and a cross-site
 * fetch with it needs a CORS preflight this route doesn't answer. A foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail(401, "noAccess", "Sign in to import");
  if (isCrossSite(request, "x-leafdesk-import")) {
    return fail(403, "badRequest", "Cross-site imports aren't allowed");
  }
  const length = Number(request.headers.get("content-length") ?? NaN);
  // Some room over the files' limit for the form's own fields and boundaries.
  if (!Number.isFinite(length)) return fail(411, "badRequest", "Send the form with a Content-Length");
  if (length > IMPORT_LIMITS.uploadBytes + 1024 * 1024) {
    return fail(413, "tooLarge", "The upload is too large", { limit: IMPORT_LIMITS.uploadBytes });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "badRequest", "Send the files as a multipart form");
  }
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };
  const uploads = form.getAll("file").filter((f): f is File => typeof f !== "string");
  const paths = form.getAll("path").map((p) => (typeof p === "string" ? p : ""));
  if (!uploads.length) return fail(400, "nothingToImport", "Choose files to import");
  if (uploads.reduce((sum, f) => sum + f.size, 0) > IMPORT_LIMITS.uploadBytes) {
    return fail(413, "tooLarge", "The upload is too large", { limit: IMPORT_LIMITS.uploadBytes });
  }
  if (uploads.length > IMPORT_LIMITS.files) {
    return fail(400, "tooManyFiles", "Too many files", { limit: IMPORT_LIMITS.files });
  }

  const actor = { userId: session.user.id };
  const workspaceId = field("workspaceId") ?? "";
  const parentId = field("parentId") || null;
  // Top level: a teamspace id, "private" for the private pages, nothing for the default teamspace.
  const space = field("teamspaceId");
  const teamspaceId = space === "private" ? null : space || undefined;
  const mode = field("mode");
  try {
    let result: ImportResult;
    if (mode === "pages") {
      const files = await Promise.all(
        uploads.map(async (f, i) => ({ path: paths[i] || f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      result = await importPages(actor, { workspaceId, parentId, teamspaceId, files, seedNames: await seedNames(), vault: field("vault") === "1" });
    } else if (mode === "csv-new" || mode === "csv-merge") {
      if (uploads.length !== 1) return fail(400, "badRequest", "Send one CSV file");
      const warnings = new WarningList();
      const sheet = field("sheet");
      const table = spreadsheetTable(
        uploads[0].name,
        new Uint8Array(await uploads[0].arrayBuffer()),
        sheet && /^\d+$/.test(sheet) ? Number(sheet) : null,
        warnings,
      );
      if (mode === "csv-new") {
        const titleColumn = field("titleColumn");
        const types = json(field("types"));
        const imported = await importCsvAsDatabase(
          actor,
          {
            workspaceId,
            parentId,
            teamspaceId,
            title: (field("title")?.trim() || cleanTitle(uploads[0].name)).slice(0, 200),
            table,
            titleColumn: titleColumn && /^\d+$/.test(titleColumn) ? Number(titleColumn) : null,
            types: Array.isArray(types)
              ? types.map((t) => (CSV_COLUMN_TYPES.includes(t as CsvColumnType) ? (t as CsvColumnType) : null))
              : undefined,
            seedNames: await seedNames(),
          },
          warnings,
        );
        result = {
          pages: [{ id: imported.database.id, title: imported.database.title, kind: "database" }],
          created: { pages: 0, databases: 1, rows: imported.rows.length, templates: 0, files: 0 },
          warnings: warnings.list,
          moreWarnings: warnings.more,
        };
        // The rows of a CSV added to a database are content: only a new database is recorded.
        const format = uploads[0].name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv";
        await recordImport(actor.userId, imported.database.workspaceId, result, format);
      } else {
        const mapping = json(field("mapping"));
        if (!Array.isArray(mapping)) return fail(400, "badMapping", "Say where each column goes");
        const imported = await importCsvIntoDatabase(
          actor,
          {
            databaseId: field("databaseId") ?? "",
            table,
            mapping: mapping.map((m): ColumnTarget => (typeof m === "string" && m ? m : null)),
          },
          warnings,
        );
        result = {
          pages: [{ id: imported.database.id, title: imported.database.title, kind: "database" }],
          created: { pages: 0, databases: 0, rows: imported.rows.length, templates: 0, files: 0 },
          warnings: warnings.list,
          moreWarnings: warnings.more,
        };
      }
    } else {
      return fail(400, "badRequest", "Unknown import mode");
    }
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ImportError) return fail(error.code === "tooLarge" ? 413 : 400, error.code, error.message, error.params);
    if (error instanceof AccessError || error instanceof TeamspaceError) return fail(404, "noAccess", error.message);
    // Guards of the pages and databases written to (a locked database, a parent in the trash).
    if (error instanceof PropertyValueError || (error instanceof Error && error.constructor === Error)) {
      return fail(400, "badRequest", error.message);
    }
    console.error("[import]", error);
    return fail(500, "badRequest", "The import failed");
  }
}

/** Names for new databases' view in the user's language (English outside a request, e.g. in scripts). */
const seedNames = () => databaseSeedNames().catch(() => undefined);

function json(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function fail(status: number, code: string, error: string, params: Record<string, string | number> = {}) {
  return Response.json({ error, code, params }, { status, headers: { "Cache-Control": "no-store" } });
}
