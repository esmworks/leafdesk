/**
 * The workspace tools an AI model may use: search, read and query pages and databases, and change
 * rows and pages. The AI chat (ai-chat.ts) offers them to a person's questions, and agents
 * (agents/) offer them to an agent's runs. Every call runs through operations.ts as `ctx.userId`,
 * with that user's access checked now, whatever the conversation said before.
 *
 * Results are registered as numbered sources (`Registry`), which the model cites as [n].
 */
import { Readable } from "node:stream";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, type ChatChange, type ChatQueryCondition, type ChatStepRecord, type ChatWriteRecord, type PageKind } from "@/db/schema";
import type { ChatActionView, ChatPageView } from "@/lib/ai-chat";
import type { RowChangeBefore, RowChangePayload } from "@/lib/pending-changes";
import { BLOCK_EDIT_OPS, blockEditProblem, MAX_BLOCK_EDITS, type BlockEdit } from "@/lib/block-edits";
import { FILTER_OPS, MAX_FILTER_DEPTH } from "@/lib/filters";
import { env } from "@/lib/env";
import { cleanFileName, formatBytes } from "@/lib/files";
import { pageLabel } from "@/lib/labels";
import { isPageLocked, PAGE_LOCKED_MESSAGE } from "@/lib/page-lock";
import { foldUnchanged, type BlockChange } from "@/lib/page-diff";
import { reviewChanges, type ReviewBlock } from "@/lib/page-review";
import { PropertyValueError } from "@/lib/properties";
import { anyWordTerms } from "@/lib/search-words";
import { AccessError, pageAccessOf } from "@/server/access";
import type { AiTool } from "@/server/ai";
import { formatSources, truncateText, type ChatSourceText } from "@/server/ai/prompts";
import type { ChatDecision } from "@/server/ai-chat-approvals";
import { getCollab } from "@/server/collab/bridge";
import { getDatabase, getLookups, normalizeRowProperties } from "@/server/databases";
import { assertExportAllowed, ExportError } from "@/server/export";
import { uploadFile } from "@/server/files";
import { ToolInputError } from "@/server/mcp/format";
import { describeProperty } from "@/server/mcp/query";
import * as ops from "@/server/operations";
import { getTree } from "@/server/pages";
import { pagePdf } from "@/server/pdf";
import { outdatedState } from "@/server/page-outdated";
import { chunksOfPages, inSubtree } from "@/server/semantic-search";
import { bestChunkForTerms, chunkPage, passageOf } from "@/server/semantic-text";

/** The most of the prompt the workspace map takes, and the databases it lists properties of. */
export const MAP_CHARS = 8_000;
const MAP_SCHEMAS = 20;
/** Passages sent with a question, and results of one search. */
const PASSAGES = 6;
export const PASSAGE_CHARS = 1_200;
/** The most of a page one read_page call returns. */
const PAGE_CHARS = 12_000;
/** Rows a database read lists (then cut to PAGE_CHARS like any page). */
const DATABASE_ROWS = 200;
/** Rows one query_database call returns by default, and at most. */
const QUERY_ROWS = 30;
const MAX_QUERY_ROWS = 100;
/** Filter rules a query step shows. */
const STEP_CONDITIONS = 6;
/** The start of a new page's text the person is shown when asked. */
const CONTENT_PREVIEW = 400;
/** The most blocks a page edit shows the person when asked (its changes and a block around each). */
const PREVIEW_BLOCKS = 40;

export const CHAT_TOOLS: AiTool[] = [
  {
    name: "search_pages",
    description:
      "Searches the workspace's pages the person can read, by words and by meaning. Returns numbered sources with the best matching passage of each page.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for: words, names or a short description." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      "Reads a whole page by the page_id of a source: its text, a database row's values, or a database's properties (with their types and options) and rows with their values. Returns it as a numbered source.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id attribute of a source." },
        with_block_ids: { type: "boolean", description: 'Put a line "<!-- block <id> -->" before each block of the text, to change single blocks with edit_page.' },
      },
      required: ["page_id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_database",
    description: [
      "Lists the rows of a database that match filters on its properties, sorted as asked. Each row comes back as a numbered source with its values.",
      "Properties are named as read_page shows them (or title, created_at, updated_at), where their descriptions say what each holds; select and status values by option name.",
      `Ops: ${FILTER_OPS.join(", ")}. is_empty and is_not_empty take no value.`,
      'People (person, created_by, last_edited_by): contains or not_equals with "me" for the person asking, or a name.',
      "Relations: contains or not_equals with a related row's title. Text: contains, does_not_contain (ignoring case), equals, not_equals.",
      "Numbers and dates: equals, gt, gte, lt, lte (gte / lte include the value: on or after, on or before); dates as YYYY-MM-DD (a range matches when it covers, starts before or ends after the day).",
      'Several values in one rule: is_any_of / is_none_of with a list, on select and status (option names), multi_select, relations and people ("me" included).',
      'is_within on dates: today, this_week, this_month, or past_n_days / next_n_days with "days".',
      `Rules all match unless filter_combinator is "or"; a group {"type": "group", "combinator": "and" | "or", "rules": [...]} mixes them (${MAX_FILTER_DEPTH} levels at most).`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "The database's page_id (from a source, or the database_id a row's source names)." },
        filters: {
          type: "array",
          description: "Rules ({property, op, value, days}) and groups ({type: \"group\", combinator, rules}).",
          items: {
            type: "object",
            properties: {
              property: { type: "string" },
              op: { type: "string", enum: [...FILTER_OPS] },
              value: {
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                description: "What to compare with, as text (numbers, dates, true/false, option names, \"me\"); a list for is_any_of / is_none_of.",
              },
              days: { type: "integer", description: "past_n_days / next_n_days only." },
              type: { type: "string", enum: ["group"] },
              combinator: { type: "string", enum: ["and", "or"] },
              rules: { type: "array", items: { type: "object" } },
            },
          },
        },
        filter_combinator: { type: "string", enum: ["and", "or"] },
        sorts: {
          type: "array",
          items: {
            type: "object",
            properties: { property: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } },
            required: ["property"],
          },
        },
        limit: { type: "integer", description: `Rows to return, 1-${MAX_QUERY_ROWS} (default ${QUERY_ROWS}).` },
      },
      required: ["database_id"],
      additionalProperties: false,
    },
  },
];

const PROPERTIES_HELP =
  'Values by property name, as the map or read_page shows them: option names for select and status (an array for multi_select), YYYY-MM-DD for dates (a time as 2026-10-12T14:30:00+03:00, a range as \"start/end\"), true/false for checkboxes, people by name or "me", relations by the related rows\' titles, null to clear. Follow each property\'s description (what it holds and how to fill it) and, for a select that depends on another, only the options listed for the row\'s value of that one. Example: {"Status": "In progress", "Due": "2026-10-12", "Assignee": ["me"]}';

/** Tools that change the workspace, offered unless the chat only reads. */
export const WRITE_TOOLS: AiTool[] = [
  {
    name: "create_row",
    description: "Adds a row (a task, a record…) to a database, as the person. Returns it as a numbered source.",
    parameters: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "The database's id (from the map or a source)." },
        title: { type: "string", description: "The row's title." },
        properties: { type: "object", description: PROPERTIES_HELP, additionalProperties: true },
        content: { type: "string", description: "Optional Markdown text for the row's page." },
      },
      required: ["database_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_row",
    description: "Changes a database row's values or title, as the person. Only the values given change. Returns it as a numbered source.",
    parameters: {
      type: "object",
      properties: {
        row_id: { type: "string", description: "The row's page_id (from a source)." },
        title: { type: "string", description: "A new title." },
        properties: { type: "object", description: PROPERTIES_HELP, additionalProperties: true },
      },
      required: ["row_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description:
      "Adds a page, as the person: under a page (parent_id), or without one at the top of the workspace, private to the person. Not for database rows (create_row). Returns it as a numbered source.",
    parameters: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "The page_id of the page to put it under." },
        title: { type: "string", description: "The page's title." },
        content: { type: "string", description: "The page's text, in Markdown." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_page",
    description: [
      "Changes the text of a page or database row, as the person, block by block: read it first with read_page with_block_ids to see each block's id.",
      'Edits, made in order: {"op": "replace", "block_id", "markdown"} puts the Markdown in place of the block; {"op": "insert_after", "block_id", "markdown"} adds it after the block; {"op": "append", "markdown"} adds it at the end; {"op": "delete", "block_id"} removes the block.',
      "Blocks not named stay as they are. The page is saved to its history first, and the person can keep or undo each change on the page.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page's page_id (from a source)." },
        edits: {
          type: "array",
          description: `The edits, at most ${MAX_BLOCK_EDITS}.`,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...BLOCK_EDIT_OPS] },
              block_id: { type: "string", description: "The block's id, from its <!-- block <id> --> line." },
              markdown: { type: "string", description: "The new text, in Markdown (without block lines)." },
            },
            required: ["op"],
          },
        },
      },
      required: ["page_id", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "create_pdf",
    description: [
      "Makes a PDF file of a page or database row, as the person: its title, text, tables and images as printed (a row's values only with with_properties), and attaches it to that page, at the end of its text or, with property, to a files property of the row.",
      "To make a document (an offer, a letter, a report) write it into a page or row first (create_page, create_row, edit_page), then make its PDF. Returns the file's link: give it to the person.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page or row to make the PDF of (from a source, or the one just made)." },
        file_name: { type: "string", description: "The file's name, without .pdf (the page's title when left out)." },
        property: { type: "string", description: "A files property of the row: the file goes into it instead of the text." },
        with_properties: { type: "boolean", description: "List the row's values under its title (default false)." },
      },
      required: ["page_id"],
      additionalProperties: false,
    },
  },
];
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

export type Registry = {
  sources: (ChatSourceText & { blockId: string | null })[];
  byKey: Map<string, number>;
};

export function register(registry: Registry, source: { pageId: string; blockId: string | null; title: string; text: string; note?: string }) {
  const key = `${source.pageId}#${source.blockId ?? ""}`;
  const known = registry.byKey.get(key);
  if (known !== undefined) {
    // Read again (a longer text): the model sees it again under the same number.
    const entry = registry.sources[known - 1];
    return { ...entry, text: source.text, note: source.note };
  }
  const n = registry.sources.length + 1;
  const entry = { n, ...source };
  registry.sources.push(entry);
  registry.byKey.set(key, n);
  return entry;
}

// ---------------------------------------------------------------------------- workspace map

/**
 * What the person can open in the workspace (or under the scope page), for the model to choose
 * from: the databases first, with their properties, types and options (to query them without
 * reading them first), then the pages, each with its id and where it is. Rows of databases aren't
 * listed. Cut to `maxChars`, saying so.
 */
export async function workspaceMap(ctx: ops.OperationContext, workspaceId: string, scopeId: string | null, maxChars: number) {
  const nodes = await getTree(ctx.userId, workspaceId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain = (id: string) => {
    const out: typeof nodes = [];
    for (let at = byId.get(id); at && out.length < 20; at = at.parentId ? byId.get(at.parentId) : undefined) out.unshift(at);
    return out;
  };
  const inScope = scopeId ? nodes.filter((n) => chain(n.id).some((c) => c.id === scopeId)) : nodes;
  const where = (id: string) => {
    const above = chain(id).slice(0, -1).map((c) => pageLabel(c.title));
    return above.length ? ` in ${above.join(" / ")}` : "";
  };
  const databases = inScope.filter((n) => n.kind === "database");
  const lines: string[] = [];
  if (databases.length) {
    lines.push("Databases (query_database lists their rows):");
    for (const [i, d] of databases.entries()) {
      lines.push(`- "${pageLabel(d.title)}" (database_id ${d.id})${where(d.id)}`);
      if (i >= MAP_SCHEMAS) continue;
      const out = (await ops.getPage(ctx, { page_id: d.id, offset: 0 }).catch(() => null)) as Record<string, unknown> | null;
      if (Array.isArray(out?.database_properties)) lines.push(...(out.database_properties as DescribedProperty[]).map((p) => `  ${propertyLine(p)}`));
    }
  }
  const pagesList = inScope.filter((n) => n.kind !== "database");
  if (pagesList.length) {
    lines.push("Pages (read_page reads one; search_pages finds words in them):");
    for (const p of pagesList) lines.push(`- "${pageLabel(p.title)}" (page_id ${p.id})${where(p.id)}`);
  }
  if (!lines.length) return "The person can't open any pages here yet.";
  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars - 100) {
      text += "(The rest doesn't fit: search for it.)\n";
      break;
    }
    text += `${line}\n`;
  }
  return text.trimEnd();
}

// ------------------------------------------------------------------------------------ tools

/** Searches as the person (their access checked now) and registers the results as sources. */
async function searchSources(
  ctx: ops.OperationContext,
  workspaceId: string,
  scopeId: string | undefined,
  query: string,
  registry: Registry,
  maxChars: number,
) {
  // Archived pages stay out (server/page-outdated.ts), unless the chat is about one: then what is under it is what it asks about.
  const include_archived = scopeId ? (await outdatedState(ctx.userId, scopeId)) !== null : false;
  const { results } = await ops.search(
    ctx,
    { query, workspace_id: workspaceId, limit: PASSAGES, include_archived },
    { withinPageId: scopeId, passages: true, anyWord: true },
  );
  const [values, found] = await Promise.all([rowValues(ctx, results), textPassages(results, query)]);
  return results.map((r) => {
    const best = r.passage ? { passage: r.passage, blockId: r.block_id ?? null } : found.get(r.id);
    const passage = best?.passage || r.snippet || "";
    const row = values.get(r.id);
    // A row's database first (to query it), then its values, so they survive the cut: what it
    // says is mostly in them.
    const head = row ? [`A row of the database "${row.database}" (database_id ${row.databaseId}).`, row.values].filter(Boolean).join("\n") : "";
    return register(registry, {
      pageId: r.id,
      blockId: best?.passage ? best.blockId : null,
      title: r.title,
      text: truncateText([head, passage].filter(Boolean).join("\n"), maxChars),
    });
  });
}

/**
 * For results the text search found without a passage (semantic search found none for them): the
 * passage of the page with the most of the query's words (bestChunkForTerms), so the model gets
 * the part that matched and a citation of it rather than a snippet. Indexed pages give their
 * indexed chunk and the block it starts at; pages without an index (no embeddings model, not
 * indexed yet) are cut the same way from their body's text, without a block to point at. The
 * results come from a search as the person, so their pages are ones they may read.
 */
export async function textPassages(results: { id: string; title: string; passage?: string | null }[], query: string) {
  const out = new Map<string, { passage: string; blockId: string | null }>();
  const missing = results.filter((r) => !r.passage);
  if (!missing.length) return out;
  const chunks = await chunksOfPages(missing.map((r) => r.id));
  const unindexed = missing.filter((r) => !chunks.get(r.id)?.length).map((r) => r.id);
  if (unindexed.length) {
    const bodies = await db.select({ id: page.id, text: page.contentText }).from(page).where(inArray(page.id, unindexed));
    for (const { id, text } of bodies) {
      const title = missing.find((r) => r.id === id)?.title ?? "";
      const lines = text.split("\n").filter((line) => line.trim());
      chunks.set(id, chunkPage({ title, blocks: lines.map((line) => ({ id: null, text: line })) }));
    }
  }
  const terms = anyWordTerms(query);
  for (const r of missing) {
    const best = bestChunkForTerms(chunks.get(r.id) ?? [], terms, r.title);
    const passage = best ? passageOf(best.text, r.title) : "";
    if (best && passage) out.set(r.id, { passage, blockId: best.blockId });
  }
  return out;
}

/**
 * The results that are database rows, by id: their database, and their values as the person may
 * see them now (one line, see valuesLine). Rows of databases they can't see aren't included.
 */
async function rowValues(ctx: ops.OperationContext, results: { id: string; parent_id: string | null }[]) {
  const out = new Map<string, { databaseId: string; database: string; values: string }>();
  const parentIds = [...new Set(results.flatMap((r) => (r.parent_id ? [r.parent_id] : [])))];
  if (!parentIds.length) return out;
  const databases = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(and(inArray(page.id, parentIds), eq(page.kind, "database")));
  const titles = new Map(databases.map((d) => [d.id, pageLabel(d.title)]));
  const isDatabase = new Set(titles.keys());
  await Promise.all(
    results
      .filter((r) => r.parent_id && isDatabase.has(r.parent_id))
      .map(async (r) => {
        const fields = await ops.rowFields(ctx, r.id).catch((error) => {
          if (error instanceof AccessError) return null;
          throw error;
        });
        if (fields) out.set(r.id, { databaseId: r.parent_id!, database: titles.get(r.parent_id!) ?? "", values: valuesLine(fields.properties as Record<string, unknown>) });
      }),
  );
  return out;
}

/** A row's values on one line ("Status: Done; Due: 2026-10-12"), empty ones left out. */
export function valuesLine(properties: Record<string, unknown>) {
  return Object.entries(properties)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
}

export type ToolOutcome = { content: string; isError?: boolean; step?: ChatStepRecord };

export async function runTool(
  ctx: ops.OperationContext,
  workspaceId: string,
  scopeId: string | undefined,
  call: { name: string; arguments: Record<string, unknown> },
  registry: Registry,
  room: number,
): Promise<ToolOutcome> {
  if (room < 1_000) return { content: "There is no room left in this request to search or read more. Answer with what you have.", isError: true };
  if (call.name === "search_pages") {
    const query = typeof call.arguments.query === "string" ? call.arguments.query.trim().slice(0, 500) : "";
    if (!query) return { content: "search_pages needs a query.", isError: true };
    const found = await searchSources(ctx, workspaceId, scopeId, query, registry, Math.min(PASSAGE_CHARS, Math.floor(room / PASSAGES)));
    return {
      content: found.length ? formatSources(found) : "Nothing matched. Try other words, or answer that the workspace has nothing on it.",
      step: { kind: "search", query, results: found.length },
    };
  }
  if (call.name === "read_page") {
    const pageId = typeof call.arguments.page_id === "string" ? call.arguments.page_id.trim() : "";
    const missing: ToolOutcome = { content: "No page with that id can be read. Use a page_id from a source.", isError: true };
    if (!pageId || pageId.length > 100) return missing;
    // Checked on every call, with the access the person has now.
    const withBlockIds = call.arguments.with_block_ids === true;
    const read = await readPage(ctx, workspaceId, scopeId, pageId, Math.min(PAGE_CHARS, room - 500), withBlockIds).catch((error) => {
      if (error instanceof AccessError || (error as Error)?.name === "ToolInputError") return null;
      throw error;
    });
    if (!read) return missing;
    const entry = register(registry, { pageId, blockId: null, title: read.title, text: read.text, note: read.note });
    return { content: formatSources([entry]), step: { kind: "read", pageId } };
  }
  if (call.name === "query_database") return queryRows(ctx, workspaceId, scopeId, call.arguments, registry, room);
  return { content: `Unknown tool ${call.name}.`, isError: true };
}

/**
 * query_database: the rows of a database that match the model's filters, run as the person (the
 * same operation as the MCP tool, so hidden values can't be filtered on and aren't returned), each
 * registered as a source.
 */
async function queryRows(
  ctx: ops.OperationContext,
  workspaceId: string,
  scopeId: string | undefined,
  args: Record<string, unknown>,
  registry: Registry,
  room: number,
): Promise<ToolOutcome> {
  const parsed = ops.inputs.queryDatabase.safeParse({ ...args, limit: Math.min(MAX_QUERY_ROWS, Number(args.limit) || QUERY_ROWS), view_id: undefined });
  if (!parsed.success) {
    return { content: `The query is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
  }
  const input = parsed.data;
  const missing: ToolOutcome = { content: "No database with that id can be queried. Use the database_id of a source.", isError: true };
  if (input.database_id.length > 100) return missing;
  const [found] = await db
    .select({ workspaceId: page.workspaceId, kind: page.kind, archivedAt: page.archivedAt, inTemplate: page.inTemplate })
    .from(page)
    .where(eq(page.id, input.database_id))
    .limit(1);
  if (!found || found.workspaceId !== workspaceId || found.kind !== "database" || found.archivedAt || found.inTemplate) return missing;
  if (scopeId) {
    const [inside] = await db.execute<{ one: number }>(sql`select 1 as one from ${page} p where p.id = ${input.database_id} and ${inSubtree(scopeId)}`);
    if (!inside) return missing;
  }
  let result: Awaited<ReturnType<typeof ops.queryDatabase>>;
  try {
    result = await ops.queryDatabase(ctx, input);
  } catch (error) {
    if (error instanceof AccessError) return missing;
    if (error instanceof PropertyValueError || error instanceof ToolInputError) return { content: `The query is not valid: ${error.message}`, isError: true };
    throw error;
  }
  const step: ChatStepRecord = {
    kind: "query",
    databaseId: input.database_id,
    conditions: conditionsOf(input.filters ?? []),
    ...(input.filter_combinator === "or" ? { any: true } : {}),
    results: result.total,
  };
  if (!result.rows.length) return { content: `No rows of "${result.title}" match. Try other filters, or answer that none do.`, step };
  // Rows as sources, as many as fit.
  const entries = [];
  let used = 0;
  for (const row of result.rows) {
    const text = valuesLine(row.properties as Record<string, unknown>) || "(no values)";
    if (used + text.length + row.title.length + 120 > room - 500) break;
    used += text.length + row.title.length + 120;
    entries.push(register(registry, { pageId: row.id, blockId: null, title: row.title, text }));
  }
  const shown = entries.length < result.total ? `the first ${entries.length} are below (narrow the filters for others)` : "all are below";
  return { content: `${result.total} rows of the database "${result.title}" match; ${shown}.\n${formatSources(entries)}`, step };
}

/** A query's filter rules, groups flattened, as its step shows them. */
function conditionsOf(filters: unknown[]): ChatQueryCondition[] {
  const out: ChatQueryCondition[] = [];
  const walk = (entries: unknown[]) => {
    for (const entry of entries) {
      if (out.length >= STEP_CONDITIONS || !entry || typeof entry !== "object") continue;
      const e = entry as { type?: string; rules?: unknown[]; property?: string; op?: string; value?: unknown; days?: number };
      if (e.type === "group") walk(e.rules ?? []);
      else if (e.property && e.op) {
        const shown = Array.isArray(e.value) ? e.value.map(String).join(", ") : String(e.value);
        const value = e.value === undefined ? null : `${shown}${e.days ? ` ${e.days}` : ""}`.slice(0, 80);
        out.push({ property: e.property.slice(0, 80), op: e.op, value });
      }
    }
  };
  walk(filters);
  return out;
}

// ----------------------------------------------------------------------------------- changes

/** A change the model asked for, checked and ready: what the person is asked, and the change. */
export type PreparedWrite = {
  action: ChatActionView;
  record: Omit<ChatWriteRecord, "outcome" | "pageId">;
  /** Makes the change, as the person: the row or page made or changed, with its values. */
  execute: () => Promise<{ id: string; title: string; text: string }>;
  /**
   * A row to add or change, as it would be stored (values by property id), and what it touches as
   * the row has it now: what a change proposed for review keeps (server/pending-changes.ts).
   */
  row?: { kind: "create_row" | "update_row"; databaseId: string; rowId: string | null; payload: RowChangePayload; before: RowChangeBefore | null };
};

const invalidChange = (message: string): ToolOutcome => ({ content: `The change is not valid: ${message}`, isError: true });
const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
const text = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);

/**
 * Checks a change the model asked for, as far as can be done without making it: the input, the
 * page it goes to (in the workspace and scope, not in the trash), the person's edit access and the
 * values it sets. Returns the change, or the error for the model.
 */
export async function prepareWrite(
  ctx: ops.OperationContext,
  workspaceId: string,
  scopeId: string | null,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<PreparedWrite | ToolOutcome> {
  const { userId } = ctx;
  const args = call.arguments;
  const properties =
    args.properties && typeof args.properties === "object" && !Array.isArray(args.properties) ? (args.properties as Record<string, unknown>) : undefined;
  try {
    if (call.name === "create_row") {
      const parsed = ops.inputs.createDatabaseRow.safeParse({ database_id: text(args.database_id) ?? "", title: text(args.title), properties, markdown: text(args.content) || undefined });
      if (!parsed.success) return invalidChange(issuesOf(parsed.error));
      const input = parsed.data;
      const target = await writeTarget(userId, workspaceId, scopeId, input.database_id);
      if (!target || target.page.kind !== "database") return { content: "No database with that id can be changed. Use a database_id from the map or a source.", isError: true };
      if (!canEdit(target.level)) return readOnly;
      const stored = input.properties ? await normalizeRowProperties(userId, target.page.id, input.properties) : {};
      const changes = changesOf(input.properties);
      return {
        action: { action: "createRow", target: await pageView(userId, target.page.id), title: input.title, changes, content: preview(input.markdown) },
        record: { kind: "write", action: "createRow", targetId: target.page.id, title: input.title, changes },
        execute: async () => {
          const row = await ops.createDatabaseRow(ctx, input);
          return { id: row.id, title: row.title, text: valuesLine(row.properties as Record<string, unknown>) };
        },
        row: {
          kind: "create_row",
          databaseId: target.page.id,
          rowId: null,
          payload: { title: input.title, properties: stored, ...(input.markdown ? { markdown: input.markdown } : {}) },
          before: null,
        },
      };
    }
    if (call.name === "update_row") {
      const parsed = ops.inputs.updateDatabaseRow.safeParse({ row_id: text(args.row_id) ?? "", title: text(args.title) || undefined, properties });
      if (!parsed.success) return invalidChange(issuesOf(parsed.error));
      const input = parsed.data;
      if (input.title === undefined && !Object.keys(input.properties ?? {}).length) return invalidChange("give a new title or values.");
      const target = await writeTarget(userId, workspaceId, scopeId, input.row_id);
      const parent = target?.page.parentId ? await writeTarget(userId, workspaceId, null, target.page.parentId) : null;
      if (!target || parent?.page.kind !== "database") return { content: "No database row with that id can be changed. Use the page_id of a row's source.", isError: true };
      if (!canEdit(target.level)) return readOnly;
      // Before the person is asked: a locked row keeps its title (its values stay open).
      if (input.title !== undefined && isPageLocked(target.page)) return { content: PAGE_LOCKED_MESSAGE, isError: true };
      const stored =
        input.properties && Object.keys(input.properties).length
          ? await normalizeRowProperties(userId, parent.page.id, input.properties, target.page.properties, { createdBy: target.page.createdBy })
          : {};
      const had = (target.page.properties ?? {}) as Record<string, unknown>;
      // What the person sees beside each new value: the value it has now, as they may see it.
      const now = Object.keys(input.properties ?? {}).length ? ((await ops.rowFields(ctx, target.page.id)).properties as Record<string, unknown>) : {};
      const changes = changesOf(input.properties, now);
      return {
        action: {
          action: "updateRow",
          target: await pageView(userId, target.page.id),
          title: input.title ?? null,
          ...(input.title !== undefined ? { previousTitle: target.page.title } : {}),
          changes,
          content: null,
        },
        // The values it had are for the person deciding, not kept with the conversation.
        record: { kind: "write", action: "updateRow", targetId: target.page.id, title: input.title ?? null, changes: changes.map(({ property, value }) => ({ property, value })) },
        execute: async () => {
          const row = await ops.updateDatabaseRow(ctx, input);
          return { id: row.id, title: row.title, text: valuesLine(row.properties as Record<string, unknown>) };
        },
        row: {
          kind: "update_row",
          databaseId: parent.page.id,
          rowId: target.page.id,
          payload: { ...(input.title !== undefined ? { title: input.title } : {}), properties: stored },
          before: {
            ...(input.title !== undefined ? { title: target.page.title } : {}),
            properties: Object.fromEntries(Object.keys(stored).map((id) => [id, had[id] ?? null])),
          },
        },
      };
    }
    if (call.name === "edit_page") {
      const pageId = text(args.page_id) ?? "";
      const edits = parseEdits(args.edits);
      if (typeof edits === "string") return invalidChange(edits);
      const target = await writeTarget(userId, workspaceId, scopeId, pageId);
      if (!target) return { content: "No page with that id can be changed. Use a page_id from the map or a source.", isError: true };
      if (target.page.kind === "database") return invalidChange("page_id is a database, which has no text: change its rows with update_row.");
      if (!canEdit(target.level)) return readOnly;
      if (isPageLocked(target.page)) return { content: PAGE_LOCKED_MESSAGE, isError: true };
      // Worked out now for the person to see; made again on the page as it is once they agree.
      const preview = await getCollab().editBlocks(pageId, edits, ctx.actor, { dryRun: true });
      if (preview.missing !== null) return invalidChange(`the page has no block ${preview.missing}. Read it again with read_page with_block_ids.`);
      const diff = previewDiff(preview.before ?? [], preview.after ?? []);
      return {
        action: { action: "editPage", target: await pageView(userId, pageId), title: null, changes: [], content: null, diff },
        record: { kind: "write", action: "editPage", targetId: pageId, title: null, changes: [] },
        execute: async () => {
          const write = await getCollab().editBlocks(pageId, edits, ctx.actor, { snapshot: true });
          if (write.missing !== null) throw new ToolInputError(`the page no longer has the block ${write.missing}. Read it again with read_page with_block_ids.`);
          const read = await ops.getPage(ctx, { page_id: pageId, offset: 0 }, { maxMarkdownChars: PASSAGE_CHARS });
          return { id: pageId, title: String(read.title ?? ""), text: typeof read.markdown === "string" ? read.markdown : "" };
        },
      };
    }
    if (call.name === "create_pdf") return await preparePdf(ctx, workspaceId, scopeId, args);
    if (call.name === "create_page") {
      const parentId = text(args.parent_id) || undefined;
      // In a page's scope, new pages stay in it too.
      if (scopeId && !parentId) return invalidChange("in this chat new pages go under the page in scope or a page under it: give parent_id.");
      const parsed = ops.inputs.createPage.safeParse({ workspace_id: workspaceId, parent_id: parentId, title: text(args.title), markdown: text(args.content) || undefined });
      if (!parsed.success) return invalidChange(issuesOf(parsed.error));
      const input = parsed.data;
      if (!input.title) return invalidChange("give the page a title.");
      let target: ChatPageView | null = null;
      if (input.parent_id) {
        const parent = await writeTarget(userId, workspaceId, scopeId, input.parent_id);
        if (!parent) return { content: "No page with that id can be changed. Use a page_id from the map or a source.", isError: true };
        if (parent.page.kind === "database") return invalidChange("parent_id is a database: add rows to it with create_row.");
        if (!canEdit(parent.level)) return readOnly;
        target = await pageView(userId, parent.page.id);
      }
      return {
        action: { action: "createPage", target, title: input.title, changes: [], content: preview(input.markdown) },
        record: { kind: "write", action: "createPage", targetId: input.parent_id ?? null, title: input.title, changes: [] },
        execute: async () => {
          const made = await ops.createPage(ctx, input);
          return { id: made.id, title: made.title, text: truncateText(input.markdown ?? "", PASSAGE_CHARS) };
        },
      };
    }
  } catch (error) {
    if (error instanceof PropertyValueError || error instanceof ToolInputError) return invalidChange(error.message);
    if (error instanceof AccessError) return readOnly;
    throw error;
  }
  return { content: `Unknown tool ${call.name}.`, isError: true };
}

const readOnly: ToolOutcome = { content: "The person may only read this, not change it. Tell them so.", isError: true };
const canEdit = (level: string) => level === "edit" || level === "full";

/**
 * create_pdf: the page to make a PDF of and attach it to (in the workspace and scope, the person
 * able to change it, export allowed), and the files property it goes into if one is named. The PDF
 * is made once the person agrees, from the page as it is then.
 */
async function preparePdf(
  ctx: ops.OperationContext,
  workspaceId: string,
  scopeId: string | null,
  args: Record<string, unknown>,
): Promise<PreparedWrite | ToolOutcome> {
  const { userId } = ctx;
  const pageId = text(args.page_id) ?? "";
  const target = await writeTarget(userId, workspaceId, scopeId, pageId);
  if (!target) return { content: "No page with that id can be changed. Use a page_id from the map or a source.", isError: true };
  if (target.page.kind === "database") return invalidChange("page_id is a database: make the PDF of one of its rows or of a page.");
  if (!canEdit(target.level)) return readOnly;
  try {
    await assertExportAllowed(workspaceId);
  } catch (error) {
    if (error instanceof ExportError) return { content: "The workspace's owners turned export off, so no PDF can be made. Tell the person so.", isError: true };
    throw error;
  }
  const propertyName = text(args.property);
  let filesProperty: { id: string; name: string } | null = null;
  if (propertyName) {
    const parent = target.page.parentId ? await writeTarget(userId, workspaceId, null, target.page.parentId) : null;
    if (parent?.page.kind !== "database") return invalidChange("property only applies to a database row; this page is not one.");
    const { properties, access } = await getDatabase(userId, parent.page.id);
    const found = properties.find((p) => p.id === propertyName) ?? properties.find((p) => p.name.toLowerCase() === propertyName.toLowerCase());
    if (!found) return invalidChange(`the row's database has no property "${propertyName}".`);
    if (found.type !== "files") return invalidChange(`"${found.name}" is a ${found.type} property, not a files property.`);
    access.requireValues(target.page, [found.id]);
    filesProperty = { id: found.id, name: found.name };
  } else if (isPageLocked(target.page)) {
    return { content: PAGE_LOCKED_MESSAGE, isError: true };
  }
  const withProperties = args.with_properties === true;
  const named = cleanFileName(`${(text(args.file_name) || pageLabel(target.page.title)).replace(/\.pdf$/i, "")}.pdf`);
  const changes: ChatChange[] = filesProperty ? [{ property: filesProperty.name, value: named }] : [];
  return {
    action: { action: "createPdf", target: await pageView(userId, pageId), title: named, changes, content: null },
    record: { kind: "write", action: "createPdf", targetId: pageId, title: named, changes },
    execute: async () => {
      const pdf = await pagePdf(userId, pageId, { properties: withProperties });
      const stored = await uploadFile(userId, pageId, {
        name: named,
        contentType: "application/pdf",
        body: Readable.from([pdf.bytes]),
        declaredSize: pdf.bytes.length,
      });
      await ops.placeFile(ctx, pageId, stored, filesProperty ? { filesPropertyId: filesProperty.id } : {});
      const where = filesProperty ? `in its "${filesProperty.name}" property` : "at the end of its text";
      return {
        id: pageId,
        title: pdf.title,
        text: `The PDF file "${stored.name}" (${formatBytes(stored.size)}) is attached to the page ${where}. Link: ${env.appUrl}${stored.url}`,
      };
    },
  };
}

/** A page of the workspace a change may go to, with the person's access: in scope, not in the trash or a template. */
async function writeTarget(userId: string, workspaceId: string, scopeId: string | null, pageId: string) {
  if (!pageId || pageId.length > 100) return null;
  const { page: found, level } = await pageAccessOf(userId, pageId);
  if (!found || level === "none" || found.workspaceId !== workspaceId || found.archivedAt || found.inTemplate) return null;
  if (scopeId) {
    const [inside] = await db.execute<{ one: number }>(sql`select 1 as one from ${page} p where p.id = ${pageId} and ${inSubtree(scopeId)}`);
    if (!inside) return null;
  }
  return { page: found, level };
}

async function pageView(userId: string, pageId: string): Promise<ChatPageView> {
  const seen = (await visiblePages(userId, [pageId])).get(pageId);
  return seen ? { pageId, ...seen } : null;
}

/** edit_page's edits as the model gave them, checked; or what is wrong with them. */
function parseEdits(value: unknown): BlockEdit[] | string {
  if (!Array.isArray(value) || !value.length) return "give at least one edit.";
  if (value.length > MAX_BLOCK_EDITS) return `give at most ${MAX_BLOCK_EDITS} edits at once.`;
  const edits: BlockEdit[] = [];
  for (const [i, entry] of value.entries()) {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const edit: BlockEdit = {
      op: e.op as BlockEdit["op"],
      ...(typeof e.block_id === "string" && e.block_id.trim() ? { blockId: e.block_id.trim().slice(0, 100) } : {}),
      ...(typeof e.markdown === "string" ? { markdown: e.markdown } : {}),
    };
    const problem = blockEditProblem(edit);
    if (problem) return `edits.${i}: ${problem}.`;
    edits.push(edit);
  }
  return edits;
}

/** The blocks an edit changes, with one unchanged block around each, for the person to see. */
function previewDiff(before: unknown[], after: unknown[]): BlockChange[] {
  const changes = reviewChanges(before as ReviewBlock[], after as ReviewBlock[]);
  const out: BlockChange[] = [];
  for (const item of foldUnchanged(changes)) {
    if (item.op === "hidden") continue;
    const bare = item.op === "changed" ? { ...item, block: { ...item.block, key: "" }, before: { ...item.before, key: "" } } : { ...item, block: { ...item.block, key: "" } };
    out.push(bare);
    if (out.length >= PREVIEW_BLOCKS) break;
  }
  return out;
}

/** The values a change sets, as the person is shown them, with those the row has now (`now`) when known. */
function changesOf(properties: Record<string, unknown> | undefined, now?: Record<string, unknown>): ChatChange[] {
  const shown = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(shown).filter(Boolean).join(", ");
    if (typeof value === "object") {
      const o = value as { text?: unknown; name?: unknown };
      return String(o.text ?? o.name ?? JSON.stringify(value));
    }
    return String(value);
  };
  return Object.entries(properties ?? {})
    .slice(0, 30)
    .map(([property, value]) => {
      const change: ChatChange = { property: property.slice(0, 100), value: shown(value).slice(0, 300) };
      if (now) {
        // By the name the model used, or the property's own name when it differs only in case.
        const key = property in now ? property : Object.keys(now).find((k) => k.toLowerCase() === property.toLowerCase());
        change.before = key === undefined ? "" : shown(now[key]).slice(0, 300);
      }
      return change;
    });
}

function preview(markdown: string | undefined) {
  const flat = markdown?.trim();
  if (!flat) return null;
  return flat.length > CONTENT_PREVIEW ? `${flat.slice(0, CONTENT_PREVIEW - 1).trimEnd()}…` : flat;
}

/** Makes an approved change (or records it declined): the step, and what the model is told. */
export async function applyWrite(prepared: PreparedWrite, decision: ChatDecision | "timeout", registry: Registry): Promise<ToolOutcome> {
  const { record } = prepared;
  if (decision === "decline" || decision === "timeout") {
    return {
      content:
        decision === "timeout"
          ? "The person didn't answer in time, so the change wasn't made. Say what you would have done."
          : "The person declined this change: it wasn't made. Don't try it again; say what you would have done, or ask what they want instead.",
      step: { ...record, outcome: "declined", pageId: null },
    };
  }
  try {
    const made = await prepared.execute();
    const entry = register(registry, { pageId: made.id, blockId: null, title: made.title, text: made.text || "(no values)" });
    const what =
      record.action === "createRow"
        ? "Added the row"
        : record.action === "updateRow"
          ? "Changed the row"
          : record.action === "editPage"
            ? "Changed the page's text"
            : record.action === "createPdf"
              ? "Made the PDF and attached it to the page"
              : "Added the page";
    return { content: `${what}; it is this source now:\n${formatSources([entry])}`, step: { ...record, outcome: "done", pageId: made.id } };
  } catch (error) {
    // The page was locked since the change was checked.
    if ((error as { code?: unknown }).code === "pageLocked") {
      return { content: `The change failed: ${PAGE_LOCKED_MESSAGE}`, isError: true, step: { ...record, outcome: "failed", pageId: null } };
    }
    if (error instanceof PropertyValueError || error instanceof ToolInputError || error instanceof AccessError) {
      const message = error instanceof AccessError ? "the person may not make it" : error.message;
      return { content: `The change failed: ${message}`, isError: true, step: { ...record, outcome: "failed", pageId: null } };
    }
    throw error;
  }
}

/** A page's text as the person may read it now, or null when it's out of reach or scope. */
async function readPage(ctx: ops.OperationContext, workspaceId: string, scopeId: string | undefined, pageId: string, maxChars: number, withBlockIds = false) {
  if (scopeId) {
    const [inside] = await db.execute<{ one: number }>(sql`select 1 as one from ${page} p where p.id = ${pageId} and ${inSubtree(scopeId)}`);
    if (!inside) return null;
  }
  const out = (await ops.getPage(ctx, { page_id: pageId, offset: 0, with_block_ids: withBlockIds }, { maxMarkdownChars: maxChars })) as Record<string, unknown>;
  if (out.workspace_id !== workspaceId || out.in_trash || out.template) return null;
  const parts: string[] = [];
  if (typeof out.path === "string") parts.push(`Path: ${out.path}`);
  if (out.properties && typeof out.properties === "object") {
    const lines = Object.entries(out.properties as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    if (lines.length) parts.push(lines.join("\n"));
  }
  if (Array.isArray(out.database_properties)) {
    parts.push(`A database (database_id ${pageId}; query_database lists the rows that match filters). Its properties:\n${(out.database_properties as DescribedProperty[]).map(propertyLine).join("\n")}`);
    parts.push(await databaseRows(ctx, pageId));
  } else if (typeof out.database_id === "string") {
    // A row: what its database's properties hold and how to fill them, for writing its values.
    const schema = await rowSchema(ctx, out.database_id);
    if (schema) parts.push(`A row of the database database_id ${out.database_id}, whose properties are:\n${schema}`);
  }
  if (typeof out.markdown === "string" && out.markdown.trim()) parts.push(out.markdown);
  return {
    title: String(out.title ?? ""),
    text: truncateText(parts.join("\n\n"), maxChars),
    note: out.markdown_truncated ? "Only the start of the page fits." : undefined,
  };
}

/** A row's database's properties as the person may know them, one line each (see propertyLine); null when out of reach. */
async function rowSchema(ctx: ops.OperationContext, databaseId: string) {
  try {
    const { properties, access, propertyAccess: levels } = await getDatabase(ctx.userId, databaseId);
    const lookups = await getLookups(ctx.userId, properties);
    return properties
      .map((p) => propertyLine(describeProperty(p, lookups, properties, { access: levels?.[p.id], restricted: !access.open }) as DescribedProperty))
      .join("\n");
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

type DescribedProperty = {
  name: string;
  type: string;
  description?: string;
  depends_on?: string;
  option_parents?: Record<string, string[]>;
  options?: string[];
  status_groups?: Record<string, string[]>;
  related_database?: string;
  result_type?: string;
};

/** A database property for the model to filter on: its name, type and options. */
function propertyLine(p: DescribedProperty) {
  // A status says which of its options are to do, in progress and done ("pending" is the first two).
  const groups = p.status_groups
    ? Object.entries(p.status_groups)
        .filter(([, names]) => names.length)
        .map(([group, names]) => `${group}: ${names.join(", ")}`)
        .join("; ")
    : "";
  const details = [
    groups ? `options by group: ${groups}` : p.options?.length ? `options: ${p.options.join(", ")}` : "",
    p.related_database ? `rows of "${p.related_database}"` : "",
    ["person", "created_by", "last_edited_by"].includes(p.type) ? '"me" is the person asking' : "",
    p.result_type ? `gives ${p.result_type}` : "",
    p.depends_on ? `depends on ${p.depends_on}${dependencyText(p.option_parents)}` : "",
    p.description ? `description: ${p.description.replace(/\s+/g, " ")}` : "",
  ].filter(Boolean);
  return `- ${p.name} (${[p.type, ...details].join("; ")})`;
}

/** Which options of a dependent select go with which of the other property's (the rest always do). */
function dependencyText(parents: Record<string, string[]> | undefined) {
  const pairs = Object.entries(parents ?? {}).map(([option, under]) => `${option} only with ${under.join(" or ")}`);
  return pairs.length ? ` (${pairs.join(", ")}; other options with any)` : "";
}

/**
 * A database's rows, one line each with the values the person may see, in the database's order.
 * The page is cut to fit later; the line count says when rows are left out.
 */
async function databaseRows(ctx: ops.OperationContext, databaseId: string) {
  const { rows, total } = await ops.queryDatabase(ctx, { database_id: databaseId, limit: DATABASE_ROWS });
  if (!rows.length) return "It has no rows.";
  const lines = rows.map((r) => {
    const values = valuesLine(r.properties as Record<string, unknown>);
    return `- ${r.title} (page_id ${r.id})${values ? ` — ${values}` : ""}`;
  });
  const shown = rows.length < total ? `The first ${rows.length} of its ${total} rows (search for others by name):` : `Its ${total} rows:`;
  return `${shown}\n${lines.join("\n")}`;
}

/** The pages of `ids` the person can open now, with what the chat shows of them. */
export async function visiblePages(userId: string, ids: string[]) {
  const visible = new Map<string, { title: string; icon: string | null; kind: PageKind; workspaceId: string }>();
  for (const id of new Set(ids)) {
    const { page: found, level } = await pageAccessOf(userId, id);
    if (found && level !== "none" && !found.archivedAt && !found.inTemplate) {
      visible.set(id, { title: found.title, icon: found.icon, kind: found.kind, workspaceId: found.workspaceId });
    }
  }
  return visible;
}
