import { icalValues, MAX_ICAL_BYTES, readCalendar, type IcalField, type IcalMapping, type IcalRow, ICAL_STATUSES } from "@/lib/ical-sync";
import type { PropertyType } from "@/lib/property-types";
import { getCollab } from "@/server/collab/bridge";
import { ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { getProperties } from "@/server/databases";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncRow } from "@/server/jira-sync/run";
import { openJson } from "@/server/secret-box";
import { addOptions, applyRows, liveFields, type SyncedDatabase } from "@/server/synced-rows";

/**
 * Reading a calendar's events (lib/ical-sync) and writing them into its synced database, called by
 * server/jira-sync/run, which holds and records every synced database's runs. The address is
 * fetched through the connections' fetch for web pages: http or https on the usual web ports, to a
 * public address only unless the host is in CONNECTOR_ALLOWED_HOSTS. An error is a JiraError (the
 * runs record every source alike); it never carries the answer.
 */

/** Sealed with the sync: the calendar's address, which for a private calendar is its key. */
export type IcalAuth = { url: string };

const TIMEOUT_MS = 30_000;

/** The type a mapped property must still have to be written. */
const TYPES: Record<IcalField, PropertyType> = {
  key: "text",
  when: "date",
  location: "text",
  description: "text",
  status: "select",
  organizer: "text",
  link: "url",
};

/** The calendar file at `url`, read up to MAX_ICAL_BYTES. */
async function fetchCalendarText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await connectionFetch(url, { headers: { Accept: "text/calendar, */*;q=0.5", "User-Agent": "Leafdesk" }, signal: AbortSignal.timeout(TIMEOUT_MS) }, { web: true });
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new JiraError("invalidSite", error.message);
    throw new JiraError("unreachable", "The calendar could not be reached");
  }
  if (response.status === 401) throw new JiraError("unauthorized", "The calendar asks for a sign-in");
  if (response.status === 403) throw new JiraError("forbidden", "The calendar refused");
  if (response.status === 404 || response.status === 410) throw new JiraError("notFound", "No calendar at this address");
  if (response.status >= 500 || response.status === 429) throw new JiraError("unreachable", `The calendar answered ${response.status}`);
  if (!response.ok) throw new JiraError("failed", `The calendar answered ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_ICAL_BYTES) throw new JiraError("tooManyIssues", "The calendar is too big");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ICAL_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new JiraError("tooManyIssues", "The calendar is too big");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The calendar's events in the sync's window (lib/ical-sync readCalendar), and its name. */
export async function fetchCalendar(url: string, untitled?: string, now = Date.now()) {
  const read = readCalendar(await fetchCalendarText(url), now, untitled);
  if (!read) throw new JiraError("notFound", "No calendar at this address");
  if (read.tooMany) throw new JiraError("tooManyIssues", "The calendar has too many events");
  return read;
}

/** Writes events into the database as `runAs` (who must be able to edit it). Returns how many rows it added and changed. */
export async function applyEvents(database: SyncedDatabase, runAs: string, mapping: IcalMapping, rows: IcalRow[]) {
  const before = await getProperties(database.id);
  const live = liveFields<IcalField>(mapping, TYPES, "key", before);
  const statusProp = before.find((p) => p.id === live.status);
  const added = await addOptions(statusProp, ICAL_STATUSES.map((status) => ({ name: mapping.statuses[status] })));
  if (added) getCollab().broadcast(`db:${database.id}`, "schema");
  const props = added ? await getProperties(database.id) : before;
  const fields = { ...live, statuses: mapping.statuses };
  const items = rows.map((row) => ({ key: row.key, title: row.title, values: icalValues(row, fields) }));
  return applyRows(database, runAs, live.key!, items, props, []);
}

/** One run of a calendar sync whose database `runAs` may edit. */
export async function runIcal(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const { url } = openJson<IcalAuth>(sync.secrets);
  const mapping = sync.mapping as IcalMapping;
  const { rows } = await fetchCalendar(url, mapping.untitled);
  const written = await applyEvents(database, runAs, mapping, rows);
  return { count: rows.length, ...written };
}
