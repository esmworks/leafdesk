import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import {
  labelsNeeded,
  PULL_STAGE_GROUPS,
  PULL_STAGES,
  pullValues,
  type GithubPullRow,
  type GithubPullsField,
  type GithubPullsMapping,
  type GithubPullsQuery,
} from "@/lib/github-pulls-sync";
import type { PropertyType } from "@/lib/property-types";
import { getMembership, inWorkspace, isGuest } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { getProperties } from "@/server/databases";
import type { SyncRow } from "@/server/jira-sync/run";
import { openJson } from "@/server/secret-box";
import { addOptions, applyRows, liveFields, type SyncedDatabase } from "@/server/synced-rows";
import { fetchPulls } from "./client";

/**
 * A run of a GitHub pull request sync (lib/github-pulls-sync), called by server/jira-sync/run, which
 * holds and records every synced database's runs. People are found by the GitHub account they
 * signed in to Leafdesk with, when they are in the workspace; anyone else's login goes in the text
 * beside.
 */

/** The type a mapped property must still have to be written. */
const TYPES: Record<GithubPullsField, PropertyType> = {
  number: "number",
  state: "status",
  author: "person",
  authorOthers: "text",
  assignees: "person",
  assigneesOthers: "text",
  labels: "multi_select",
  branch: "text",
  base: "text",
  created: "date",
  merged: "date",
  link: "url",
};

/** Sealed with the sync: the token, null for public repositories. */
export type GithubAuth = { token: string | null };

/**
 * The workspace's people by the GitHub account ids they sign in with. None for a guest running the
 * sync, who can't look people up.
 */
async function githubPeople(runAs: string, workspaceId: string, ids: string[]) {
  const people = new Map<string, string>();
  const membership = await getMembership(runAs, workspaceId);
  if (!ids.length || !membership || isGuest(membership.role)) return people;
  const found = await db
    .select({ accountId: account.accountId, userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, "github"), inArray(account.accountId, ids), inWorkspace(account.userId, workspaceId)));
  for (const { accountId, userId } of found) people.set(accountId, userId);
  return people;
}

/**
 * Writes pull requests into the database as `runAs` (who must be able to edit it); `closed` only
 * keeps rows it has in step. Returns how many rows it added and changed.
 */
export async function applyPulls(
  database: SyncedDatabase,
  runAs: string,
  mapping: GithubPullsMapping,
  { rows, closed }: { rows: GithubPullRow[]; closed: GithubPullRow[] },
) {
  const before = await getProperties(database.id);
  const live = liveFields<GithubPullsField>(mapping, TYPES, "number", before);
  const prop = (field: GithubPullsField) => before.find((p) => p.id === live[field]);
  const all = [...rows, ...closed];
  const added = [
    await addOptions(
      prop("state"),
      PULL_STAGES.map((stage) => ({ name: mapping.stages[stage], group: PULL_STAGE_GROUPS[stage] })),
    ),
    await addOptions(prop("labels"), labelsNeeded(all).map((name) => ({ name }))),
  ].some(Boolean);
  if (added) getCollab().broadcast(`db:${database.id}`, "schema");
  const props = added ? await getProperties(database.id) : before;

  const ids = [...new Set(all.flatMap((r) => [...(r.author ? [r.author.id] : []), ...r.assignees.map((a) => a.id)]))];
  const people = await githubPeople(runAs, database.workspaceId, ids);
  const person = (user: { id: string }) => people.get(user.id) ?? null;
  const fields = { ...live, stages: mapping.stages };
  // People of new rows go in afterwards, unannounced: the author and the assignees.
  const deferred = [live.author, live.assignees].filter((id): id is string => Boolean(id));
  const item = (row: GithubPullRow, onlyUpdate: boolean) => ({
    key: String(row.number),
    title: row.title,
    values: pullValues(row, fields, person),
    onlyUpdate,
  });
  const items = [...rows.map((row) => item(row, false)), ...closed.map((row) => item(row, true))];
  return applyRows(database, runAs, live.number!, items, props, deferred);
}

/** One run of a GitHub sync whose database `runAs` may edit. */
export async function runGithubPulls(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const { token } = openJson<GithubAuth>(sync.secrets);
  const fetched = await fetchPulls(sync.siteUrl, sync.query as GithubPullsQuery, token);
  const written = await applyPulls(database, runAs, sync.mapping as GithubPullsMapping, fetched);
  return { count: fetched.rows.length, ...written };
}
