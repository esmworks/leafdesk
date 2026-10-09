import { Readable } from "node:stream";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { csvTable, decodeText, guessColumn, guessTitleColumn, splitList, type CsvColumnType, type CsvTable } from "@/lib/import/csv";
import { LOCALES } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import {
  IMPORT_LIMITS,
  importFileKind,
  liftImages,
  planImport,
  resolveLink,
  rewriteLinks,
  splitTitle,
  stripRowProperties,
  withoutFrontMatter,
  type PlanNode,
} from "@/lib/import/markdown";
import { blockReferences, frontMatterAliases, hasWikilink, obsidianMarkdown, rewriteWikilinks, VaultIndex } from "@/lib/import/obsidian";
import {
  notionId,
  notionMarkdown,
  planRelations,
  relationRefs,
  relationTitles,
  rewriteNotionUrls,
  soleLink,
  splitRowProperties,
  type RelationColumn,
  type RelationRef,
} from "@/lib/import/notion";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { PAGE_LINK_MARKER, pagePath } from "@/lib/mentions";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { addProperty } from "@/server/databases";
import { FileError, uploadFile } from "@/server/files";
import { createPage, removeOrphanFiles, type DatabaseSeedNames } from "@/server/pages";
import { collectFiles, type UploadedFile } from "./archive";
import { importCsvAsDatabase } from "./csv";

/**
 * Imports Markdown files, CSV files and ZIPs of them as pages under a page (or at the top level of
 * a workspace), keeping their folders as the page tree (see lib/import/markdown for the layout).
 *
 * In two passes: first every page and database is created, so that then each page's Markdown can
 * be written with its links rewritten: links to other imported files become links to their pages
 * (which the editor shows as page mentions), and images and files it shows by relative path are
 * uploaded to the page and the links pointed at the uploads.
 *
 * Leafdesk's own export comes back as it went: `Templates/` folders become row templates of their
 * database and, when importing at the workspace's top level, workspace templates (elsewhere they're
 * a page of that name: templates only live at the top), and the property list the export writes at
 * the top of a row's page is left out of the body when the row's CSV values say the same.
 *
 * An Obsidian vault (see lib/import/obsidian) comes in with its wikilinks and embeds as links to
 * the pages and uploads they name, wherever in the vault those are, and its callouts as callouts.
 * Links that name nothing in the upload stay as they were written.
 *
 * Notion's "Markdown & CSV" export (see lib/import/notion) comes in with its callouts as callouts,
 * the property list at the top of each row's page taken off (its files kept), relation columns
 * whose links lead to rows of the upload as relations (linked once every row exists), links to
 * notion.so pages of the upload pointed at the imported pages, and a line linking to a subpage as
 * a link-to-page block where it was.
 *
 * All or nothing: limits are checked before anything is created, and if creating or writing fails
 * midway, what the import created so far is deleted again (uploads with it). What an import that
 * went through left out (a missing image, a file over the upload limit, a file no page shows) comes
 * back as warnings.
 */

const text = decodeText;

/** Titles the export gives untitled pages (in each language), for matching a row with no title. */
const UNTITLED = new Set(
  (await Promise.all(LOCALES.map(loadMessages))).map((messages) => messages.common.untitled.toLowerCase()),
);

export type MarkdownImportInput = {
  workspaceId: string;
  /** The page the import goes under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  files: UploadedFile[];
  seedNames?: DatabaseSeedNames;
  /** The upload is an Obsidian vault: its `.obsidian` folder was seen but not sent (a folder upload). */
  vault?: boolean;
};

type Created = { id: string; kind: "page" | "database" | "row"; title: string; template: boolean };

/** Rows of a relation's values written per statement. */
const RELATION_CHUNK = 500;

export async function importPages(actor: WriteActor, input: MarkdownImportInput): Promise<ImportResult> {
  const { userId } = actor;
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Pages can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  }

  const warnings = new WarningList();
  const collected = collectFiles(input.files);
  const files = collected.files;
  for (const s of collected.skipped) warnings.add({ code: "skipped", path: s.path, reason: s.reason });
  // Markdown files over the limit are left out rather than read.
  for (const [path, bytes] of files) {
    if (importFileKind(path) === "markdown" && bytes.byteLength > IMPORT_LIMITS.markdownBytes) {
      files.delete(path);
      warnings.add({ code: "skipped", path, reason: "tooLarge" });
    }
  }
  const plan = planImport([...files.keys()], { topLevel: input.parentId === null });
  // Notion writes every database twice (and a page of the same name); leaving those copies out is
  // expected, so they aren't warned about.
  for (const s of plan.skipped) if (s.reason !== "duplicate") warnings.add({ code: "skipped", path: s.path, reason: s.reason });
  if (!plan.nodes.length) throw new ImportError("There is no Markdown or CSV file to import", "nothingToImport");
  if (plan.nodes.length > IMPORT_LIMITS.pages) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
  }
  const nodeByKey = new Map(plan.nodes.map((n) => [n.key, n]));
  // An Obsidian vault: its settings folder came along, or a note has a wikilink.
  const isVault =
    collected.vault || input.vault || plan.nodes.some((n) => n.source && importFileKind(n.source) === "markdown" && hasWikilink(text(files.get(n.source)!)));

  // Block ids the vault's links point at: those are left out of the notes where they are set.
  const referencedBlocks = new Set(
    isVault ? plan.nodes.flatMap((n) => (n.source && importFileKind(n.source) === "markdown" ? blockReferences(text(files.get(n.source)!)) : [])) : [],
  );

  // The databases' CSV files, read once: their headers are needed for the row pages below.
  const tables = new Map<string, { table: CsvTable; titleColumn: number }>();
  for (const node of plan.nodes) {
    if (node.kind !== "database") continue;
    const table = csvTable(text(files.get(node.source!)!));
    tables.set(node.key, { table, titleColumn: guessTitleColumn(table.headers) });
  }

  // Titles and bodies from the files. A folder keeps its name; its index file's heading only goes
  // (as the title) when it names the folder the same.
  const bodies = new Map<string, string>();
  const titles = new Map<string, string>();
  // The property list at the top of Notion row pages, by the row's key: values by column name.
  const rowProperties = new Map<string, Map<string, string>>();
  for (const node of plan.nodes) {
    if (!node.source || node.kind === "database") {
      titles.set(node.key, node.title);
      continue;
    }
    const markdown = text(files.get(node.source)!);
    const split = splitTitle(markdown, node.title);
    let body: string;
    if (node.key.endsWith("/") && split.title.toLowerCase() !== node.title.toLowerCase()) {
      titles.set(node.key, node.title);
      body = withoutFrontMatter(markdown);
    } else {
      titles.set(node.key, split.title);
      body = split.body;
    }
    const csv = node.kind === "row" && !node.template && notionId(node.source) ? tables.get(node.parent!) : undefined;
    if (csv) {
      const properties = splitRowProperties(body, csv.table.headers, csv.titleColumn);
      if (properties.values.size) {
        rowProperties.set(node.key, properties.values);
        // Files the list links to have nowhere else to go: their lines stay, as the page's first lines.
        const kept = [...properties.values]
          .filter(([, value]) => linksToAsset(value, node.source!, files))
          .map(([name, value]) => `${name}: ${value}`);
        body = [...kept, properties.body].join("\n\n");
      }
    }
    bodies.set(node.key, isVault && !notionId(node.source) ? obsidianMarkdown(notionMarkdown(body), referencedBlocks) : notionMarkdown(body));
  }

  // What wikilinks and links by name can name: the pages (with their aliases) and the other files.
  const vault = new VaultIndex(
    plan.nodes
      .filter((n) => n.source)
      .map((n) => ({
        path: n.source!,
        aliases: importFileKind(n.source!) === "markdown" ? frontMatterAliases(text(files.get(n.source!)!)) : [],
      })),
    [...files.keys()].filter((p) => importFileKind(p) === "asset"),
  );

  // Relations (see lib/import/notion): which columns link to rows of which imported database.
  const byNotionId = new Map<string, string>();
  for (const node of plan.nodes) {
    for (const path of [node.source, node.key]) {
      const id = path ? notionId(path) : null;
      if (id && !byNotionId.has(id)) byNotionId.set(id, node.key);
    }
  }
  const nodeOfRef = (ref: RelationRef): PlanNode | null => {
    const key = (ref.path ? plan.nodeOf.get(ref.path) : undefined) ?? (ref.id ? byNotionId.get(ref.id) : undefined);
    return key ? (nodeByKey.get(key) ?? null) : null;
  };
  const { relations, plain } = planRelations(
    plan.nodes
      .filter((n) => n.kind === "database")
      .map((n) => {
        const { table, titleColumn } = tables.get(n.key)!;
        return {
          key: n.key,
          source: n.source!,
          headers: table.headers,
          rows: table.rows,
          titleColumn,
          rowPages: plan.nodes
            .filter((r) => r.parent === n.key && rowProperties.has(r.key))
            .map((r) => ({ source: r.source!, values: rowProperties.get(r.key)! })),
        };
      }),
    (ref) => {
      const node = nodeOfRef(ref);
      return node?.kind === "row" && !node.template ? node.parent : null;
    },
  );
  // Columns whose links lead out of the upload stay text: the titles, without the links.
  for (const [key, columns] of plain) {
    const { table } = tables.get(key)!;
    const source = nodeByKey.get(key)!.source!;
    for (const row of table.rows) for (const c of columns) row[c] = relationTitles(row[c] ?? "", source);
  }

  const created = new Map<string, Created>();
  const roots: Created[] = [];
  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  // Rows of imported databases that no page of the database's folder has claimed yet, with their
  // cells (to recognise the property list an exported row page starts with) and their line in the CSV.
  type Unclaimed = { id: string; title: string; cells: string[]; line: number };
  const unclaimed = new Map<string, Unclaimed[]>();
  // Every row of each imported database (its CSV's, in order, then pages the CSV didn't have), and
  // which page of the folder each CSV line went to.
  const rowsOf = new Map<string, { id: string; title: string }[]>();
  const pageOfLine = new Map<string, Map<number, string>>();
  try {
    for (const node of plan.nodes) {
      const parentId = node.parent ? created.get(node.parent)!.id : input.parentId;
      const title = titles.get(node.key)!;
      let id: string;
      if (node.kind === "database") {
        const { table, titleColumn } = tables.get(node.key)!;
        const linked = new Set((relations.get(node.key) ?? []).map((r) => r.column));
        // Relation columns are left out here and added once every database exists.
        const types = linked.size
          ? table.headers.map((_, i): CsvColumnType | null =>
              i === titleColumn || linked.has(i) ? null : guessColumn(table.rows.map((r) => r[i] ?? "")).type,
            )
          : undefined;
        const result = await importCsvAsDatabase(
          actor,
          {
            workspaceId,
            parentId,
            teamspaceId: input.teamspaceId,
            title,
            table,
            titleColumn,
            types,
            seedNames: input.seedNames,
            template: node.template,
          },
          warnings,
        );
        id = result.database.id;
        // Rows come back in the CSV's order.
        unclaimed.set(node.key, result.rows.map((r, i) => ({ ...r, cells: table.rows[i], line: i })));
        rowsOf.set(node.key, [...result.rows]);
        pageOfLine.set(node.key, new Map());
        if (node.template) counts.templates++;
        else counts.databases++;
        counts.rows += result.rows.length;
      } else {
        const rows = node.kind === "row" && !node.template ? unclaimed.get(node.parent!) : undefined;
        const match = rows ? matchRow(rows, title) : -1;
        if (rows && match !== -1) {
          const row = rows.splice(match, 1)[0];
          id = row.id;
          pageOfLine.get(node.parent!)!.set(row.line, node.key);
          const body = bodies.get(node.key);
          const { table, titleColumn } = tables.get(node.parent!)!;
          if (body !== undefined) bodies.set(node.key, stripRowProperties(body, table.headers, row.cells, titleColumn));
        } else {
          id = (await createPage(actor, { workspaceId, parentId, teamspaceId: input.teamspaceId, title, template: node.template })).id;
          if (node.template) counts.templates++;
          else if (node.kind === "row") {
            counts.rows++;
            rowsOf.get(node.parent!)?.push({ id, title });
          } else counts.pages++;
        }
      }
      const entry: Created = { id, kind: node.kind, title, template: Boolean(node.template) };
      created.set(node.key, entry);
      if (!node.parent) roots.push(entry);
    }

    // Uploads by path: one stored file however many pages show it (null: it couldn't be stored).
    const uploads = new Map<string, string | null>();
    const target = (path: string): string | null => {
      const key = plan.nodeOf.get(path) ?? plan.nodeOf.get(path.replace(/\/$/, ""));
      const linked = key ? created.get(key) : undefined;
      return linked ? pagePath(workspaceId, linked.id) : null;
    };
    const notionTarget = (id: string) => {
      const linked = byNotionId.has(id) ? created.get(byNotionId.get(id)!) : undefined;
      return linked ? pagePath(workspaceId, linked.id) : null;
    };
    for (const node of plan.nodes) {
      let body = bodies.get(node.key);
      if (body === undefined) continue;
      const pageId = created.get(node.key)!.id;
      if (notionId(node.source!)) body = subpageBlocks(body, node, plan.nodeOf);
      else {
        body = rewriteWikilinks(body, node.source!, vault, (link) =>
          warnings.add({ code: "unresolvedLink", target: link, page: titles.get(node.key)! }),
        );
      }
      body = rewriteNotionUrls(body, notionTarget);
      const pending: { path: string; token: string }[] = [];
      let rewritten = rewriteLinks(body, node.source!, ({ path: written, href }) => {
        // Not a path from this file: a link by name (or from the top), as Obsidian writes them. Outside
        // a vault only a bare name is looked for elsewhere, so a broken path isn't taken for another file.
        const byName = isVault || !/\/|%2f/i.test(href);
        const path = files.has(written) || plan.nodeOf.has(written) || !byName ? written : (vault.href(href, node.source!) ?? written);
        const linked = target(path);
        if (linked) return linked;
        if (!files.has(path) || importFileKind(path) !== "asset") {
          warnings.add({ code: "missingFile", path, page: titles.get(node.key)! });
          return null;
        }
        // Uploads are async and this callback isn't: a placeholder now, the file's URL below.
        const token = `leafdesk-import-${pending.length}-${Math.random().toString(36).slice(2)}`;
        pending.push({ path, token });
        return token;
      });
      for (const { path, token } of pending) {
        if (!uploads.has(path)) uploads.set(path, await store(userId, pageId, path, files.get(path)!, warnings, counts));
        const url = uploads.get(path);
        rewritten = rewritten.replace(token, url ?? encodeURI(relativeTo(node.source!, path)));
      }
      if (rewritten.trim()) await getCollab().replaceContent(pageId, liftImages(rewritten), actor);
    }

    for (const [key, columns] of relations) {
      await linkRelations(userId, {
        databaseId: created.get(key)!.id,
        source: nodeByKey.get(key)!.source!,
        table: tables.get(key)!.table,
        rows: rowsOf.get(key)!,
        columns,
        rowsOf,
        created,
        pageOfLine: pageOfLine.get(key)!,
        rowProperties,
        sourceOf: (rowKey) => nodeByKey.get(rowKey)?.source ?? null,
        nodeOfRef,
        warnings,
      });
    }

    // Files that no page shows or links to: nowhere to put them.
    for (const path of files.keys()) {
      if (importFileKind(path) === "asset" && !uploads.has(path)) warnings.add({ code: "skipped", path, reason: "unused" });
    }
  } catch (error) {
    await discard(workspaceId, roots);
    throw error;
  }

  return {
    // Templates after the pages: they're not in the sidebar, so the pages are what to open first.
    pages: [...roots.filter((r) => !r.template), ...roots.filter((r) => r.template)].map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind === "database" ? ("database" as const) : ("page" as const),
    })),
    created: counts,
    warnings: warnings.list,
    moreWarnings: warnings.more,
  };
}

/** Whether a property value links to a file of the upload that isn't a page (a Files property). */
function linksToAsset(value: string, from: string, files: Map<string, Uint8Array>): boolean {
  let found = false;
  rewriteLinks(value, from, ({ path }) => {
    if (files.has(path) && importFileKind(path) === "asset") found = true;
    return null;
  });
  return found;
}

/**
 * A Notion page's lines that are nothing but a link to one of its own subpages (Notion writes each
 * subpage so, where it sits in the page) marked as link-to-page blocks (see lib/mentions).
 */
function subpageBlocks(markdown: string, node: PlanNode, nodeOf: Map<string, string>): string {
  let fence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
      if (fence) return line;
      const href = soleLink(line);
      const path = href ? resolveLink(node.source!, href) : null;
      const key = path ? (nodeOf.get(path) ?? nodeOf.get(path.replace(/\/$/, ""))) : undefined;
      return key && key !== node.key && subpageOf(key, node.key, nodeOf) ? `${line.trim()} ${PAGE_LINK_MARKER}` : line;
    })
    .join("\n");
}

/** Whether the node `key` sits right under `parent` (its path is in the parent's folder). */
function subpageOf(key: string, parent: string, nodeOf: Map<string, string>): boolean {
  const folder = parent.endsWith("/") ? parent : parent.replace(/\.[^./]+$/, "/");
  const own = key.endsWith("/") ? key.slice(0, -1) : key;
  return own.startsWith(folder) && !own.slice(folder.length).includes("/") && nodeOf.has(key);
}

/**
 * Makes a database's relation columns relation properties (to the database each points to) and
 * links its rows: each entry of a cell by its link (a row page of the upload), else by title
 * among the related database's rows (when exactly one has it). A cell with no links falls back to
 * the links in its row page's property list. Entries that find no row are counted in a warning.
 * Rows are written straight away (they were all created by this import, as were the targets) and
 * the relations are one-way: Notion exports both sides of a two-way relation as columns.
 */
async function linkRelations(
  userId: string,
  input: {
    databaseId: string;
    source: string;
    table: CsvTable;
    rows: { id: string; title: string }[];
    columns: RelationColumn[];
    rowsOf: Map<string, { id: string; title: string }[]>;
    created: Map<string, Created>;
    pageOfLine: Map<number, string>;
    rowProperties: Map<string, Map<string, string>>;
    sourceOf: (rowKey: string) => string | null;
    nodeOfRef: (ref: RelationRef) => PlanNode | null;
    warnings: WarningList;
  },
) {
  for (const column of input.columns) {
    const targetId = input.created.get(column.target)!.id;
    const property = await addProperty(userId, input.databaseId, {
      name: column.header,
      type: "relation",
      relation: { databaseId: targetId },
    });
    const byTitle = new Map<string, string[]>();
    for (const row of input.rowsOf.get(column.target) ?? []) {
      const key = row.title.trim().toLowerCase();
      byTitle.set(key, [...(byTitle.get(key) ?? []), row.id]);
    }
    const values: { id: string; ids: string[] }[] = [];
    let missing = 0;
    // Only the CSV's lines: rows added from pages it didn't have carry no cells.
    input.table.rows.forEach((cells, line) => {
      const row = input.rows[line];
      if (!row) return;
      const cell = cells[column.column] ?? "";
      let refs = relationRefs(cell, input.source);
      if (!refs.some((r) => r.path || r.id)) {
        const rowKey = input.pageOfLine.get(line);
        const listed = rowKey ? input.rowProperties.get(rowKey)?.get(column.header) : undefined;
        const fromPage = listed ? relationRefs(listed, input.sourceOf(rowKey!)!) : [];
        if (fromPage.length) refs = fromPage;
        else if (!refs.length) refs = splitList(cell).map((title) => ({ title, path: null, id: null }));
      }
      const ids: string[] = [];
      for (const ref of refs) {
        const node = input.nodeOfRef(ref);
        let id = node && node.parent === column.target && !node.template ? input.created.get(node.key)?.id : undefined;
        if (!id) {
          const same = byTitle.get(ref.title.trim().toLowerCase());
          if (same?.length === 1) id = same[0];
        }
        if (!id) missing++;
        else if (!ids.includes(id)) ids.push(id);
      }
      if (ids.length) values.push({ id: row.id, ids });
    });
    for (let i = 0; i < values.length; i += RELATION_CHUNK) {
      const chunk = values.slice(i, i + RELATION_CHUNK);
      await db.execute(sql`
        update ${page} set properties = ${page.properties} || jsonb_build_object(${property.id}::text, v.ids)
        from (values ${sql.join(
          chunk.map((v) => sql`(${v.id}::text, ${JSON.stringify(v.ids)}::jsonb)`),
          sql`, `,
        )}) as v(id, ids)
        where ${page.id} = v.id
      `);
    }
    if (missing) input.warnings.add({ code: "invalidValues", column: column.header, count: missing });
  }
  getCollab().broadcast(`db:${input.databaseId}`, "rows");
}

/**
 * Which of a database's unclaimed rows a page of its folder is: the one of the same title (without
 * case), else, for a page titled the way the export titles untitled pages, a row with no title.
 */
function matchRow(rows: { title: string }[], title: string): number {
  const wanted = title.trim().toLowerCase();
  const same = rows.findIndex((r) => r.title.trim().toLowerCase() === wanted);
  if (same !== -1 || !UNTITLED.has(wanted)) return same;
  return rows.findIndex((r) => !r.title.trim());
}

/** A path as the link had it: relative to the file linking to it. */
function relativeTo(from: string, path: string) {
  const fromDir = from.split("/").slice(0, -1);
  const parts = path.split("/");
  let common = 0;
  while (common < fromDir.length && common < parts.length - 1 && fromDir[common] === parts[common]) common++;
  return [...fromDir.slice(common).map(() => ".."), ...parts.slice(common)].join("/");
}

/** Stores a file a page shows; null (and a warning) when it can't be. */
async function store(
  userId: string,
  pageId: string,
  path: string,
  data: Uint8Array,
  warnings: WarningList,
  counts: { files: number },
): Promise<string | null> {
  try {
    const stored = await uploadFile(userId, pageId, {
      name: path.slice(path.lastIndexOf("/") + 1),
      body: Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]),
      declaredSize: data.byteLength,
    });
    counts.files++;
    return stored.url;
  } catch (error) {
    if (error instanceof FileError && (error.code === "tooLarge" || error.code === "quotaExceeded")) {
      warnings.add({ code: "fileNotStored", path, reason: error.code });
      return null;
    }
    if (error instanceof AccessError) throw error;
    console.error(`[import] couldn't store ${path}`, error);
    warnings.add({ code: "fileNotStored", path, reason: "failed" });
    return null;
  }
}

/** Deletes what a failed import created: its top-level pages with everything under them. */
async function discard(workspaceId: string, roots: Created[]) {
  if (!roots.length) return;
  try {
    await db.delete(page).where(inArray(page.id, roots.map((r) => r.id)));
    getCollab().broadcast(`ws:${workspaceId}`, "tree");
    await removeOrphanFiles(workspaceId);
  } catch (error) {
    console.error("[import] couldn't take back a failed import", error);
  }
}
