import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, page, sheetsWrite } from "@/db/schema";
import {
  createdEventId,
  eventCreate,
  eventRows,
  eventUpdate,
  GCAL_PAGE_SIZE,
  GCAL_TOOL,
  GCAL_WRITE_TOOLS,
  gcalAccess,
  gcalWindow,
  gcalWriteAccess,
  MAX_GCAL_EVENTS,
  MAX_GCAL_WRITES,
  writesCalendar,
  type GcalMapping,
  type GcalQuery,
  type GcalRow,
  type GcalSyncError,
  type GcalWritten,
} from "@/lib/gcal-sync";
import type { IcalField } from "@/lib/ical-sync";
import { answerJson, answerText, type ToolAnswer } from "@/lib/import/google-docs";
import { redactError, redactText } from "@/lib/redact";
import { AccessError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { callConnectionTool, classify, type ConnectionRow } from "@/server/connections/client";
import { inputSummary } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import { applyEvents, ICAL_TYPES, type HeldFields } from "@/server/ical-sync/run";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncRow } from "@/server/jira-sync/run";
import { fromSync } from "@/server/sync-writes";
import { liveFields, type SyncedDatabase } from "@/server/synced-rows";

/**
 * Reading a Google calendar's events (lib/gcal-sync) through a workspace's Google Calendar
 * connection and writing them into the synced database, called by server/jira-sync/run, which
 * holds and records every synced database's runs; for a sync that writes back, writing the changes
 * waiting in `sheets_write` (server/sync-writes) to the calendar first. Each run checks again that
 * the person it runs as may read (and write) through the connection (lib/gcal-sync gcalAccess,
 * gcalWriteAccess), and each call to it is recorded in the audit log, as the AI chat's calls are.
 * An error is a JiraError (the runs record every source alike).
 */

/** A connection a sync reads through, with the role in its workspace of the person it's used as. */
export type GcalConnection = ConnectionRow & { role: Awaited<ReturnType<typeof requireMembership>>["role"] };

/** The connection a sync reads through, if `userId` may read calendars through it now. */
export async function gcalConnection(userId: string, connectionId: string): Promise<GcalConnection> {
  const [row] = connectionId ? await db.select().from(connection).where(eq(connection.id, connectionId)).limit(1) : [];
  if (!row) throw new JiraError("notFound", "The Google Calendar connection is gone");
  let role;
  try {
    ({ role } = await requireMembership(userId, row.workspaceId));
  } catch (error) {
    if (error instanceof AccessError) throw new JiraError("accessLost", error.message);
    throw error;
  }
  if (row.status === "needsAuth") throw new JiraError("unauthorized", "The connection needs signing in again");
  // A connection that failed its last check may answer again: the run tries again next time.
  if (row.status !== "ready") throw new JiraError("unreachable", "The connection is failing");
  if (!row.tools.some((t) => t.name === GCAL_TOOL)) throw new JiraError("notFound", "The connection has no list_events tool");
  if (!gcalAccess(row, role)) throw new JiraError("forbidden", "The connection may not be used for this");
  return { ...row, role };
}

/**
 * Calls one of the connection's tools as `userId`, recording it in the audit log like the chat's
 * calls (a write with the people whose changes it writes). Returns the answer's JSON, if any.
 */
export async function callCalendar(
  userId: string,
  row: ConnectionRow,
  tool: string,
  args: Record<string, unknown>,
  editors: string[] = [],
): Promise<Record<string, unknown> | null> {
  const kind = (GCAL_WRITE_TOOLS as readonly string[]).includes(tool) ? "write" : "read";
  const audit = (outcome: "done" | "failed", error?: string) =>
    recordAudit({
      workspaceId: row.workspaceId,
      actorId: userId,
      action: "connection.tool_called",
      target: { type: "connection", id: row.id, label: row.name },
      details: {
        tool,
        kind,
        input: inputSummary(args),
        approvedBy: null,
        outcome,
        via: "sync",
        ...(editors.length ? { editors } : {}),
        ...(error ? { error: redactText(error).slice(0, 200) } : {}),
      },
    }).catch((e) => console.error("[calendar sync] could not record a call", redactError(e)));
  let answer: ToolAnswer;
  try {
    answer = (await callConnectionTool(row, tool, args)) as ToolAnswer;
  } catch (error) {
    const failure = classify(error);
    await audit("failed", `${failure.code}: ${failure.message}`);
    if (failure.code === "unauthorized") throw new JiraError("unauthorized", "The connection needs signing in again");
    throw new JiraError("unreachable", "The connection could not be reached");
  }
  if (answer.isError) {
    const said = answerText(answer).slice(0, 500);
    await audit("failed", said);
    if (/not.?found|\b404\b/i.test(said)) throw new JiraError("notFound", "No such calendar or event");
    if (/permission|forbidden|\b403\b/i.test(said)) throw new JiraError("forbidden", `The connection's account may not ${kind} the calendar`, redactText(said).slice(0, 300) || null);
    throw new JiraError("badQuery", `Google refused the ${kind}`, redactText(said).slice(0, 300) || null);
  }
  await audit("done");
  return answerJson(answer);
}

export type ReadCalendar = {
  /** The calendar's name and time zone, as Google gives them. */
  name: string;
  timeZone: string;
  /** Whether the connection's account may write events to it. */
  mayWrite: boolean;
  rows: GcalRow[];
};

/**
 * A calendar's events in the sync's window (lib/gcal-sync gcalWindow), page by page. Ordered by
 * start, which Google answers only with each occurrence of a repeating event on its own.
 */
export async function readEvents(userId: string, row: ConnectionRow, calendarId: string, untitled?: string, now = Date.now()): Promise<ReadCalendar> {
  const window = gcalWindow(now);
  const events: unknown[] = [];
  let first: Record<string, unknown> | null = null;
  let pageToken: string | undefined;
  for (;;) {
    const json = await callCalendar(userId, row, GCAL_TOOL, { calendarId, ...window, timeZone: "UTC", orderBy: "startTime", pageSize: GCAL_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
    if (!json) throw new JiraError("badQuery", "Google's answer couldn't be read");
    first ??= json;
    if (Array.isArray(json.events)) events.push(...json.events);
    if (events.length > MAX_GCAL_EVENTS) throw new JiraError("tooManyIssues", "The calendar has too many events");
    const next = typeof json.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : undefined;
    if (!next || next === pageToken) break;
    pageToken = next;
  }
  const mayWrite = writesCalendar(first.accessRole);
  return {
    name: typeof first.summary === "string" ? first.summary : "",
    timeZone: typeof first.timeZone === "string" && first.timeZone ? first.timeZone : "UTC",
    mayWrite,
    rows: eventRows(events, calendarId, mayWrite, untitled),
  };
}

/** Why writing to the calendar failed, as the sync's dialog shows it; null once it went through. */
type WriteFailure = { code: GcalSyncError; detail: string | null } | null;

/** The properties the sync writes back, of those that still exist with their types. */
const writtenOf = (live: Partial<Record<IcalField, string>>): GcalWritten => ({ when: live.when, location: live.location, description: live.description });

/**
 * Writes the changes waiting for a sync to the calendar as just read (lib/gcal-sync eventUpdate,
 * eventCreate), as `runAs` through `row`, which must let them write. A refusal stops the writing
 * but not the run: the changes wait, and their fields keep Leafdesk's values. Changes to events the
 * account may not change, or that are gone, are dropped: the read puts the calendar's values back.
 * Returns whether it wrote, why it couldn't, and whether more changes than one run writes wait.
 */
async function writeBack(
  syncId: string,
  database: SyncedDatabase,
  runAs: string,
  row: GcalConnection,
  query: GcalQuery,
  mapping: GcalMapping,
  live: Partial<Record<IcalField, string>>,
  read: ReadCalendar,
) {
  const keyId = live.key!;
  const entries = await db
    .select({ id: sheetsWrite.id, rowId: sheetsWrite.rowId, created: sheetsWrite.created, before: sheetsWrite.before, editedBy: sheetsWrite.editedBy, version: sheetsWrite.version })
    .from(sheetsWrite)
    .where(eq(sheetsWrite.syncId, syncId))
    .orderBy(asc(sheetsWrite.queuedAt))
    .limit(MAX_GCAL_WRITES);
  if (!entries.length) return { wrote: false, failure: null as WriteFailure, more: false };
  const more = entries.length === MAX_GCAL_WRITES;
  if (!gcalWriteAccess(row, row.role)) return { wrote: false, failure: { code: "forbidden", detail: null } as WriteFailure, more };
  const pages = await db
    .select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt, parentId: page.parentId })
    .from(page)
    .where(inArray(page.id, entries.map((e) => e.rowId)));
  const rows = new Map(pages.filter((p) => !p.archivedAt && p.parentId === database.id).map((p) => [p.id, p]));
  const events = new Map(read.rows.map((r) => [r.key, r]));
  const fields = writtenOf(live);
  const editors = [...new Set(entries.flatMap((e) => (e.editedBy ? [e.editedBy] : [])))].slice(0, 20);
  const target = { calendarId: query.calendarId, timeZone: read.timeZone };

  let wrote = false;
  let failure: WriteFailure = null;
  /** Entries written or dropped; `created` those that made an event. */
  const done: string[] = [];
  const created = new Set<string>();
  try {
    for (const entry of entries) {
      const current = rows.get(entry.rowId);
      if (!current) {
        done.push(entry.id);
        continue;
      }
      const key = typeof current.properties[keyId] === "string" ? (current.properties[keyId] as string).trim() : "";
      if (entry.created && !key) {
        if (!read.mayWrite) {
          failure = { code: "forbidden", detail: null };
          break;
        }
        const args = eventCreate(current, fields, target, mapping.untitled);
        // Without a When it waits for one.
        if (!args) continue;
        const id = createdEventId(await callCalendar(runAs, row, "create_event", args, editors));
        if (!id) throw new JiraError("badQuery", "Google's answer had no event");
        wrote = true;
        await db
          .update(page)
          .set({ properties: sql`${page.properties} || ${JSON.stringify({ [keyId]: id })}::jsonb` })
          .where(eq(page.id, current.id));
        done.push(entry.id);
        created.add(entry.id);
        continue;
      }
      const event = events.get(key);
      const args = event?.writable ? eventUpdate(current, entry.before, event, fields, target) : null;
      if (args) {
        await callCalendar(runAs, row, "update_event", args, editors);
        wrote = true;
      }
      done.push(entry.id);
    }
  } catch (error) {
    // A sign-in that ran out stops reading too; anything else leaves the changes waiting.
    if (!(error instanceof JiraError) || error.code === "unauthorized") throw error;
    failure = { code: error.code as GcalSyncError, detail: error.detail };
  }
  // Done with: removed, unless changed again meanwhile (then a row that made its event isn't new any more).
  const version = new Map(entries.map((e) => [e.id, e.version]));
  const removed = new Set(
    done.length
      ? (
          await db
            .delete(sheetsWrite)
            .where(or(...done.map((id) => and(eq(sheetsWrite.id, id), eq(sheetsWrite.version, version.get(id)!)))))
            .returning({ id: sheetsWrite.id })
        ).map((r) => r.id)
      : [],
  );
  const kept = [...created].filter((id) => !removed.has(id));
  if (kept.length) await db.update(sheetsWrite).set({ created: false }).where(inArray(sheetsWrite.id, kept));
  return { wrote, failure, more };
}

/** The changes waiting for a sync, by their rows' keys: the calendar's values don't go over them. */
async function heldFields(syncId: string, keyId: string): Promise<HeldFields> {
  const rows = await db
    .select({ before: sheetsWrite.before, properties: page.properties })
    .from(sheetsWrite)
    .innerJoin(page, eq(page.id, sheetsWrite.rowId))
    .where(eq(sheetsWrite.syncId, syncId));
  const held: HeldFields = new Map();
  for (const row of rows) {
    const key = row.properties[keyId];
    if (typeof key === "string" && key.trim()) held.set(key.trim(), new Set(Object.keys(row.before)));
  }
  return held;
}

/** One run of a calendar sync whose database `runAs` may edit: the changes waiting written first, if it writes back. */
export async function runGcal(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const query = sync.query as GcalQuery;
  const mapping = sync.mapping as GcalMapping;
  const row = await gcalConnection(runAs, query.connectionId);
  let read = await readEvents(runAs, row, query.calendarId, mapping.untitled);
  const live = liveFields<IcalField>(mapping, ICAL_TYPES, "key", await getProperties(database.id));
  let failure: WriteFailure = null;
  if (query.direction === "both") {
    const back = await writeBack(sync.id, database, runAs, row, query, mapping, live, read);
    failure = back.failure;
    // What was written comes back with the next read.
    if (back.wrote) read = await readEvents(runAs, row, query.calendarId, mapping.untitled);
    // More than one run writes: the next comes soon.
    if (back.more && !failure) await db.update(databaseSync).set({ nextRunAt: sql`now() + interval '20 seconds'` }).where(eq(databaseSync.id, sync.id));
  }
  const held = query.direction === "both" ? await heldFields(sync.id, live.key!) : new Map();
  // The run's own writes are no changes to write back (server/sync-writes).
  const written = await fromSync(() => applyEvents(database, runAs, mapping, read.rows, held));
  // The dialog shows the calendar's name; times are written in its zone; and why writing failed.
  const next = { calendarName: read.name || query.calendarName, timeZone: read.timeZone, writeError: failure?.code ?? null, writeErrorDetail: failure?.detail ?? null };
  const was = { calendarName: query.calendarName, timeZone: query.timeZone, writeError: query.writeError ?? null, writeErrorDetail: query.writeErrorDetail ?? null };
  if (JSON.stringify(next) !== JSON.stringify(was)) {
    // Only these keys: a change of the sync made meanwhile (its direction, connection) stays.
    await db
      .update(databaseSync)
      .set({ query: sql`${databaseSync.query} || ${JSON.stringify(next)}::jsonb` })
      .where(eq(databaseSync.id, sync.id));
  }
  return { count: read.rows.length, ...written };
}
