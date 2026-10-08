import { and, eq, inArray, sql } from "drizzle-orm";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { db } from "@/db";
import { file, fileReference, page, propertyPermission, type PageKind, workspace } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { isErrorValue, valueType } from "@/lib/derived";
import { mapReferenceLines, markdownReferences } from "@/lib/embed-blocks";
import { env } from "@/lib/env";
import { layoutExport, relativeLink, rewriteLinks, type ExportLayout } from "@/lib/export-layout";
import { asFiles, fileIdOf, fileIdsIn, fileIdsInProperties, formatBytes } from "@/lib/files";
import { pageLabel } from "@/lib/labels";
import { asChecklist, displayValue } from "@/lib/properties";
import { toXlsx, type XlsxValue } from "@/lib/xlsx";
import { holdsPeople } from "@/lib/property-types";
import { accessRank, pageIdColumn, requireMembership, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { getDatabaseSnapshot } from "@/server/databases";
import { resolveEmbeds } from "@/server/embeds";
import { labelPageLinks } from "@/server/mentions";
import { propertyAccessFor, type PropertyAccess } from "@/server/property-access";
import { getStorage } from "@/server/storage";
import { exportAllowed } from "@/server/workspaces";

/**
 * Exports: one page as Markdown or one database as CSV or Excel (the page menu's "Export"), and a page with
 * everything under it, or a whole workspace, as a ZIP of Markdown files, database CSVs and the
 * uploaded files they show (see lib/export-layout for the archive's layout).
 *
 * Only what the exporting user can view goes in: pages and rows are filtered by
 * `page_access_level` like the sidebar, links to pages they can't see are labelled "No access",
 * and database blocks name only databases they can see. Row values go through their property
 * access (server/property-access): database CSVs and row pages hold only what they may see, and
 * files held only by properties whose values they may not see stay out of the archive; a workspace
 * export by an owner goes by the owner's own access too. Pages in the trash are left out (a page
 * exported from the trash brings the subpages that went to the trash with it). Templates are kept
 * apart in `Templates/` folders.
 *
 * The archive is streamed as it is built, one entry at a time and only as fast as the client
 * reads it; limits on pages and file bytes are checked before the first byte is sent.
 */

export type ExportLabels = { untitled: string; noAccess: string; deleted: string; unavailable: string };

export const ENGLISH_EXPORT_LABELS: ExportLabels = {
  untitled: "Untitled",
  noAccess: "No access",
  deleted: "Deleted page",
  unavailable: "Database unavailable",
};

// ---------------------------------------------------------------------------------------------
// One page, one database

/**
 * A page's body as Markdown for `userId`: mentions and page links under the titles they may see,
 * database blocks as links to databases they may see. Links stay app paths (`/w/…/p/…`).
 */
export async function pageMarkdown(userId: string, pageId: string, labels: ExportLabels = ENGLISH_EXPORT_LABELS) {
  const content = await getCollab().readPage(pageId);
  const labelled = await labelPageLinks(userId, content.markdown.trim(), labels);
  return { title: content.title, body: await linkEmbeds(userId, labelled, labels) };
}

/** Title heading and body, as one Markdown file. */
export function markdownFile(title: string, body: string, properties: string[] = []) {
  const head = title ? `# ${title}\n\n` : "";
  const props = properties.length ? `${properties.join("\n")}\n\n` : "";
  return `${head}${props}${body}`.trimEnd() + "\n";
}

/**
 * Database blocks as links to their database, for readers who can see it; a note otherwise, which
 * names nothing (see lib/embed-blocks).
 */
async function linkEmbeds(userId: string, markdown: string, labels: ExportLabels) {
  const embeds = await resolveEmbeds(userId, markdownReferences(markdown));
  if (!embeds.length) return markdown;
  const byId = new Map(embeds.map((e) => [e.databaseId, e.database]));
  return mapReferenceLines(markdown, (ref) => {
    const database = byId.get(ref.databaseId);
    if (!database) return `*${labels.unavailable}*`;
    return `[${pageLabel(database.title, labels.untitled).replace(/[[\]]/g, "\\$&")}](/w/${database.workspaceId}/p/${database.id})`;
  });
}

type Snapshot = Awaited<ReturnType<typeof getDatabaseSnapshot>>;

/**
 * A database's rows as table cells, header first, the way the CSV export writes them. `fileText`
 * writes one file of a files property (its name and where to find it).
 */
export function databaseTable(
  snapshot: Snapshot,
  rows: Snapshot["rows"],
  fileText: (f: { name: string; url: string }) => string,
): { header: string[]; cells: (string | number | null)[][] } {
  const titleOf = new Map(Object.values(snapshot.relations).flatMap((r) => r.rows.map((row) => [row.id, row.title] as const)));
  // A relation to the same database would otherwise print ids for its trashed rows.
  if (snapshot.database.archived) for (const row of rows) if (!titleOf.has(row.id)) titleOf.set(row.id, row.title);
  const nameOf = new Map(snapshot.people.map((p) => [p.id, p.name] as const));
  const cell = (value: unknown, names: Map<string, string>): string | number | null => {
    if (value === null || value === undefined || value === "") return null;
    if (Array.isArray(value)) return value.map((v) => names.get(String(v)) ?? String(v)).join(", ");
    if (typeof value === "boolean") return value ? "true" : "false";
    return typeof value === "number" ? value : String(value);
  };
  // One line per checklist item, "[x] Done thing" / "[ ] Open thing".
  const checklist = (value: unknown) =>
    asChecklist(value)
      .map((item) => `[${item.checked ? "x" : " "}] ${item.text}`)
      .join("\n") || null;
  const files = (value: unknown) => asFiles(value).map(fileText).join("\n") || null;
  return {
    header: ["Name", ...snapshot.properties.map((p) => p.name)],
    cells: rows.map((row) => [
      row.title,
      ...snapshot.properties.map((p) => {
        const value = row.properties[p.id];
        // A formula that fails on this row says why.
        if (isErrorValue(value)) return `#ERROR: ${value.error.message}`;
        if (p.type === "files") return files(value);
        return p.type === "checklist" ? checklist(value) : cell(displayValue(p, value), holdsPeople(p.type) ? nameOf : titleOf);
      }),
    ]),
  };
}

/**
 * A database's rows for a one-file export (all of them, or those of `only`, in that order) as
 * table cells, recorded in the audit log as exported in `format`.
 */
async function exportedTable(userId: string, databaseId: string, only: string[] | null, format: "csv" | "xlsx") {
  const snapshot = await getDatabaseSnapshot(userId, databaseId);
  await assertExportAllowed(snapshot.database.workspaceId);
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
  const rows = only ? only.flatMap((id) => byId.get(id) ?? []) : snapshot.rows;
  // "photo.png (https://…/api/files/…)": the link opens for people who can see the row.
  const table = databaseTable(snapshot, rows, (f) => `${f.name} (${env.appUrl}${f.url})`);
  await recordExport(userId, {
    workspaceId: snapshot.database.workspaceId,
    page: { id: databaseId, title: snapshot.database.title },
    format,
    rows: rows.length,
  });
  return { snapshot, ...table };
}

/** A database's rows (all of them, or those of `only`, in that order) as CSV, and its title. */
export async function databaseCsv(userId: string, databaseId: string, only: string[] | null = null) {
  const { snapshot, header, cells } = await exportedTable(userId, databaseId, only, "csv");
  return { title: snapshot.database.title, csv: toCsv([header, ...cells]) };
}

/**
 * A database's rows as an Excel workbook (.xlsx), and its title: the cells of the CSV export, with
 * numbers as numbers, checkboxes as TRUE/FALSE and dates as dates (created and edited times with
 * their time, in UTC).
 */
export async function databaseXlsx(userId: string, databaseId: string, only: string[] | null = null) {
  const { snapshot, header, cells } = await exportedTable(userId, databaseId, only, "xlsx");
  const kinds = [null, ...snapshot.properties.map((p) => valueType(p))];
  const typed = cells.map((row) => row.map((value, i) => typedCell(value, kinds[i])));
  return { title: snapshot.database.title, xlsx: toXlsx([header, ...typed], { name: snapshot.database.title }) };
}

/**
 * A cell of the CSV export as a workbook cell of its column's type: anything that isn't what the
 * type holds (a formula's error, say) stays text.
 */
export function typedCell(value: string | number | null, type: string | null): XlsxValue {
  if (typeof value === "number" || value === null) return value;
  if (type === "checkbox" && (value === "true" || value === "false")) return value === "true";
  if ((type === "date" || type === "created_time" || type === "last_edited_time") && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) {
    return { date: value };
  }
  return value;
}

export type ExportRecord = {
  workspaceId: string;
  /** The page exported; null for the whole workspace. */
  page: { id: string; title: string } | null;
  format: "zip" | "csv" | "xlsx" | "markdown" | "pdf";
  /** How many pages (or rows, or files) it holds, when known. */
  pages?: number;
  rows?: number;
  files?: number;
};

/**
 * Records an export in the audit log, once it is about to be handed over: the whole workspace
 * (a ZIP from Settings), or one page as Markdown, CSV, ZIP (with its subpages) or the print view.
 */
export async function recordExport(userId: string, { workspaceId, page: exported, format, ...counts }: ExportRecord) {
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: exported ? "export.page" : "export.workspace",
    target: exported ? { type: "page", id: exported.id, label: exported.title } : { type: "workspace", id: workspaceId },
    details: { format, ...counts },
  });
}

// ---------------------------------------------------------------------------------------------
// ZIP exports: planning

export type ExportScope = { pageId: string } | { workspaceId: string };

export class ExportError extends Error {
  constructor(
    readonly code: "tooManyPages" | "tooLarge" | "busy" | "disabled",
    /** The limit that was hit: pages, or bytes of files. */
    readonly limit?: number,
  ) {
    super(
      code === "tooManyPages"
        ? `Exports can hold at most ${limit} pages`
        : code === "tooLarge"
          ? `Exports can hold at most ${formatBytes(limit ?? 0)} of files`
          : code === "disabled"
            ? "Export is turned off in this workspace"
            : "An export is already running",
    );
    this.name = "ExportError";
  }
}

/**
 * Refuses exports (and the print view) of the workspace's pages while its owners have export
 * turned off. `databaseCsv` and `planExport` ask it themselves; one page's Markdown is checked by
 * the export route, since archives read each page's Markdown after their plan was checked.
 */
export async function assertExportAllowed(workspaceId: string) {
  if (!(await exportAllowed(workspaceId))) throw new ExportError("disabled");
}

const MB = 1024 * 1024;

/** ZIPs without ZIP64 (fflate writes none) hold at most 65,535 entries and 4 GiB. */
const HARD_MAX_ENTRIES = 60_000;
const HARD_MAX_FILE_BYTES = 3.5 * 1024 * MB;

function positive(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Most pages (rows and templates included) one export holds, EXPORT_MAX_PAGES (10,000 by default),
 * and most bytes of uploaded files, EXPORT_MAX_FILES_MB (2,048 by default). Capped so the archive
 * never needs ZIP64.
 */
export function exportLimits() {
  return {
    maxPages: Math.min(Math.floor(positive("EXPORT_MAX_PAGES", 10_000)), HARD_MAX_ENTRIES / 2),
    maxFileBytes: Math.min(Math.floor(positive("EXPORT_MAX_FILES_MB", 2048) * MB), HARD_MAX_FILE_BYTES),
  };
}

type PlannedPage = {
  id: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  isTemplate: boolean;
  updatedAt: Date;
};

type PlannedFile = { id: string; name: string; contentType: string; size: number; storageKey: string; createdAt: Date };

export type ExportPlan = {
  workspaceId: string;
  /** The page exported (with its subpages); null for a whole workspace. */
  rootId: string | null;
  /** The name the archive is downloaded under, without `.zip`. */
  title: string;
  pages: PlannedPage[];
  files: PlannedFile[];
  layout: ExportLayout;
  fileBytes: number;
};

/**
 * What an export of `scope` holds for `userId`, checked against the limits (ExportError when over).
 * A page needs view access (AccessError otherwise); a whole workspace is for its owners.
 */
export async function planExport(userId: string, scope: ExportScope, labels: ExportLabels = ENGLISH_EXPORT_LABELS): Promise<ExportPlan> {
  const { maxPages, maxFileBytes } = exportLimits();
  let workspaceId: string;
  let rootId: string | null = null;
  let title: string;
  let where;
  if ("pageId" in scope) {
    const root = await requirePageAccess(userId, scope.pageId, "view");
    workspaceId = root.workspaceId;
    rootId = root.id;
    title = pageLabel(root.title, labels.untitled);
    // The page and everything under it that is in the trash with it (or out of it, like it).
    where = sql`p.id in (
      with recursive tree as (
        select id, archived_at from ${page} where id = ${root.id}
        union all
        select c.id, c.archived_at from ${page} c join tree t on c.parent_id = t.id
        where c.archived_at is not distinct from t.archived_at
      )
      select id from tree
    )`;
  } else {
    workspaceId = scope.workspaceId;
    await requireMembership(userId, workspaceId, "owner");
    const [ws] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
    title = ws?.name?.trim() || "Workspace";
    where = sql`p.workspace_id = ${workspaceId} and p.archived_at is null`;
  }
  await assertExportAllowed(workspaceId);

  const rows = await db.execute<{
    id: string;
    parent_id: string | null;
    kind: PageKind;
    title: string;
    is_template: boolean;
    updated_at: string | Date;
  }>(sql`
    with ranked as materialized (
      -- Materialized so the access level is worked out once per page.
      select p.id, p.parent_id, p.kind, p.title, p.is_template, p.updated_at, p.position, p.created_at,
        ${accessRank(userId, pageIdColumn("p"))} as level
      from ${page} p
      where ${where}
    )
    select id, parent_id, kind, title, is_template, updated_at
    from ranked
    where level > 0
    order by position, created_at, id
    limit ${maxPages + 1}
  `);
  if (rows.length > maxPages) throw new ExportError("tooManyPages", maxPages);
  // The root goes first, so it is named before anything shared on its own lands beside it.
  const pages: PlannedPage[] = rows
    .map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind,
      title: r.title,
      isTemplate: r.is_template,
      updatedAt: new Date(r.updated_at),
    }))
    .sort((a, b) => Number(b.id === rootId) - Number(a.id === rootId));
  if (rootId) {
    // The page exported sits at the top, even a template (which would otherwise go to Templates/).
    const root = pages.find((p) => p.id === rootId);
    if (root) Object.assign(root, { parentId: null, isTemplate: false });
  }

  // Files the exported pages show in their bodies or hold in files properties (file_reference,
  // kept by triggers for both), of this workspace only. A row whose values are partly kept from the
  // exporter only brings the files its body and the values they may see hold.
  const ids = pages.map((p) => p.id);
  const restricted = await restrictedRowFiles(userId, ids);
  const files: PlannedFile[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const found = await db
      .selectDistinct({
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        storageKey: file.storageKey,
        createdAt: file.createdAt,
        pageId: fileReference.pageId,
      })
      .from(file)
      .innerJoin(fileReference, eq(fileReference.fileId, file.id))
      .where(and(eq(file.workspaceId, workspaceId), inArray(fileReference.pageId, ids.slice(i, i + 5000))));
    for (const { pageId, ...f } of found) {
      const shown = restricted.get(pageId);
      if (!shown || shown.has(f.id)) files.push(f);
    }
  }
  const unique = [...new Map(files.map((f) => [f.id, f])).values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const fileBytes = unique.reduce((sum, f) => sum + Number(f.size), 0);
  if (fileBytes > maxFileBytes) throw new ExportError("tooLarge", maxFileBytes);

  const layout = layoutExport(
    pages.map((p) => ({ id: p.id, parentId: p.parentId, kind: p.kind, title: p.title, isTemplate: p.isTemplate })),
    unique.map((f) => ({ id: f.id, name: f.name })),
    labels.untitled,
  );
  return { workspaceId, rootId, title, pages, files: unique, layout, fileBytes };
}

/**
 * The files a row shows `userId`: those its body links to and those the values they may see hold
 * (see PropertyAccess.strip), for rows of databases with property access rules. Other rows are
 * left out of the map: every file they reference goes in.
 */
async function restrictedRowFiles(userId: string, pageIds: string[]) {
  const out = new Map<string, Set<string>>();
  const withRules = db.selectDistinct({ id: propertyPermission.databaseId }).from(propertyPermission);
  const accessOf = new Map<string, Promise<PropertyAccess>>();
  for (let i = 0; i < pageIds.length; i += 5000) {
    const rows = await db
      .select({
        id: page.id,
        parentId: page.parentId,
        properties: page.properties,
        createdBy: page.createdBy,
        contentMarkdown: page.contentMarkdown,
      })
      .from(page)
      .where(and(inArray(page.id, pageIds.slice(i, i + 5000)), inArray(page.parentId, withRules)));
    for (const row of rows) {
      const databaseId = row.parentId!;
      if (!accessOf.has(databaseId)) accessOf.set(databaseId, propertyAccessFor(userId, databaseId));
      const access = await accessOf.get(databaseId)!;
      if (!access.open) out.set(row.id, visibleFileIds(row, access));
    }
  }
  return out;
}

/** The files a row shows through `access`: its body's, and those of the values it lets through. */
export function visibleFileIds(
  row: { properties: Record<string, unknown> | null; createdBy: string | null; contentMarkdown: string | null },
  access: PropertyAccess,
): Set<string> {
  const [shown] = access.strip([{ properties: row.properties ?? {}, createdBy: row.createdBy }]);
  return new Set([...fileIdsIn(row.contentMarkdown ?? ""), ...fileIdsInProperties(shown.properties)]);
}

// ---------------------------------------------------------------------------------------------
// ZIP exports: one export at a time per person

const running = new Map<string, number>();
const MAX_RUNNING = 4;

/** Whether `userId` has an export running (a dry run says so before they ask for another). */
export const exportRunning = (userId: string) => running.has(userId);

/**
 * Takes a slot for an export by `userId`: one at a time per person, a few at a time per server.
 * Returns the function that gives it back (safe to call more than once).
 */
export function startExport(userId: string): () => void {
  const total = [...running.values()].reduce((a, b) => a + b, 0);
  if (running.has(userId) || total >= MAX_RUNNING) throw new ExportError("busy");
  running.set(userId, 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running.delete(userId);
  };
}

// ---------------------------------------------------------------------------------------------
// ZIP exports: writing

/** Types that are compressed already: stored as they are rather than deflated again. */
const COMPRESSED = /^(image\/(png|jpeg|gif|webp|avif|heic)|video\/|audio\/|application\/(zip|pdf|gzip|x-7z-compressed|vnd\.openxmlformats))/;

/** ZIP dates run from 1980 to 2107; fflate refuses anything else. */
function zipTime(date: Date) {
  const time = date.getTime();
  if (!Number.isFinite(time)) return new Date(Date.UTC(2000, 0, 1));
  return new Date(Math.min(Math.max(time, Date.UTC(1980, 0, 2)), Date.UTC(2099, 11, 31)));
}

/** A property value for a row's Markdown file: one line, files as links. */
const oneLine = (value: string | number | null) => (value === null ? "" : String(value).replace(/\s*\n\s*/g, ", "));

/**
 * The archive for `plan`, as a stream the response can send. `onDone` runs once it has been sent,
 * failed, or been cancelled by the client.
 */
export function exportArchive(
  userId: string,
  plan: ExportPlan,
  { labels = ENGLISH_EXPORT_LABELS, onDone }: { labels?: ExportLabels; onDone?: () => void } = {},
): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.length) queue.push(chunk);
  });
  const encoder = new TextEncoder();
  const storage = getStorage();

  async function* build(): AsyncGenerator<void> {
    // Files first: a link is only rewritten to a file that made it into the archive.
    const written = new Map<string, string>();
    for (const f of plan.files) {
      const path = plan.layout.files.get(f.id)!;
      const body = await storage.get(f.storageKey).catch((error) => {
        console.error(`[export] couldn't read ${f.storageKey}`, error);
        return null;
      });
      if (!body) continue;
      const entry = COMPRESSED.test(f.contentType) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
      entry.mtime = zipTime(f.createdAt);
      zip.add(entry);
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value);
          yield;
        }
      } finally {
        reader.releaseLock();
        await body.cancel().catch(() => {});
      }
      entry.push(new Uint8Array(0), true);
      written.set(f.id, path);
      yield;
    }

    const targets = {
      page: (id: string) => plan.layout.paths.get(id),
      file: (id: string) => written.get(id),
      appUrl: env.appUrl,
    };
    const add = (path: string, text: string, mtime: Date) => {
      const entry = new ZipDeflate(path, { level: 6 });
      entry.mtime = zipTime(mtime);
      zip.add(entry);
      entry.push(encoder.encode(text), true);
    };
    const fileLink = (from: string) => (f: { name: string; url: string }) => {
      const id = fileIdOf(f.url);
      const to = id ? written.get(id) : undefined;
      return to ? `${f.name} (${relativeLink(from, to)})` : `${f.name} (${env.appUrl}${f.url})`;
    };

    // Databases next: their snapshots give the property lines of their rows' pages.
    const rowProperties = new Map<string, string[]>();
    for (const database of plan.pages.filter((p) => p.kind === "database")) {
      const path = plan.layout.paths.get(database.id)!;
      const snapshot = await getDatabaseSnapshot(userId, database.id);
      const { header, cells } = databaseTable(snapshot, snapshot.rows, fileLink(path));
      add(path, toCsv([header, ...cells]), database.updatedAt);
      // Row files sit one folder below the CSV, so their links are made from there.
      const table = databaseTable(snapshot, snapshot.rows, (f) => {
        const id = fileIdOf(f.url);
        const rowPath = `${path.slice(0, -4)}/row.md`;
        const to = id ? written.get(id) : undefined;
        return `[${f.name.replace(/[[\]\\]/g, "\\$&")}](${to ? relativeLink(rowPath, to) : `${env.appUrl}${f.url}`})`;
      });
      snapshot.rows.forEach((row, i) => {
        const lines = table.header
          .slice(1)
          .map((name, j) => [name, oneLine(table.cells[i][j + 1])] as const)
          .filter(([, value]) => value !== "")
          .map(([name, value]) => `- ${name}: ${value}`);
        rowProperties.set(row.id, lines);
      });
      yield;
    }

    for (const p of plan.pages) {
      if (p.kind === "database") continue;
      const path = plan.layout.paths.get(p.id)!;
      const { title, body } = await pageMarkdown(userId, p.id, labels);
      const markdown = markdownFile(pageLabel(title || p.title, labels.untitled), body, rowProperties.get(p.id));
      add(path, rewriteLinks(markdown, path, targets), p.updatedAt);
      yield;
    }
    zip.end();
  }

  const steps = build();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length) {
          const { done } = await steps.next();
          if (zipError) throw zipError;
          if (done) {
            // The central directory, written by zip.end().
            while (queue.length) controller.enqueue(queue.shift()!);
            controller.close();
            finish();
            return;
          }
        }
        while (queue.length) controller.enqueue(queue.shift()!);
      } catch (error) {
        console.error("[export] failed", error);
        controller.error(error);
        finish();
      }
    },
    async cancel() {
      await steps.return(undefined).catch(() => {});
      finish();
    },
  });
}

/** `Content-Disposition` for a download named after `title`. */
export function attachment(title: string, extension: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
  return `attachment; filename="${base.replace(/[^\x20-\x7e]/g, "_")}.${extension}"; filename*=UTF-8''${encodeURIComponent(base).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}.${extension}`;
}

/** The HTTP response for an export problem: JSON the page menu and settings read. */
export function exportErrorResponse(error: ExportError) {
  return Response.json(
    { error: error.code, limit: error.limit ?? null, message: error.message },
    { status: error.code === "busy" ? 429 : error.code === "disabled" ? 403 : 413, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The response streaming the archive for `plan`, holding the export slot until it is sent. The
 * export is recorded in the audit log first.
 */
export async function archiveResponse(userId: string, plan: ExportPlan, labels: ExportLabels, release: () => void) {
  const root = plan.rootId ? plan.pages.find((p) => p.id === plan.rootId) : null;
  await recordExport(userId, {
    workspaceId: plan.workspaceId,
    page: plan.rootId ? { id: plan.rootId, title: root?.title ?? plan.title } : null,
    format: "zip",
    pages: plan.pages.length,
    files: plan.files.length,
  });
  const stream = exportArchive(userId, plan, { labels, onDone: release });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachment(plan.title, "zip"),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** What a dry run reports: the archive would be made, and roughly what it holds. */
export const planSummary = (plan: ExportPlan) => ({
  ok: true,
  pages: plan.pages.length,
  files: plan.files.length,
  fileBytes: plan.fileBytes,
});
