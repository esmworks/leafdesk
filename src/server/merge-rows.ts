/**
 * Merging duplicate rows of a database (lib/merge-rows.ts): one row is kept and takes, property by
 * property, the values picked for it; everything else the other rows hold comes along to it, and
 * they go to the trash, each saying which row it was merged into (`page.merged_into_id`).
 *
 * What comes along: links from other rows (two-way relations, sub-items and dependencies included,
 * and one-way relations of any database pointing at these rows), comment threads, the activity
 * (marked as coming from the merged row), uploads, matched email, followers and starred pages, and
 * each body that isn't empty, after the kept row's own under a heading naming the row it came from.
 * Pages inside a merged row (subpages) go to the trash with it and come back with it. Formulas and
 * rollups follow by themselves: they are worked out from the links whenever rows are read.
 *
 * The merger needs to be able to edit every row merged, and every other row whose links change;
 * otherwise nothing happens and the error names the rows in the way. Properties they may not
 * change in the kept row (property access) keep its values. The rows are locked while the merge is
 * worked out and written, in one transaction; the bodies and threads (in the rows' documents) are
 * written right after it. Taking a merged row out of the trash makes it a row of its own again,
 * without the links, activity and email that moved to the kept row.
 */

import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  databaseProperty,
  file,
  page,
  pageFavorite,
  pageMention,
  pageReminder,
  rowActivity,
  rowEmail,
  rowFollower,
  threadMute,
  type RowProperties,
} from "@/db/schema";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { blockedByProperty } from "@/lib/dependencies";
import { pageLabel } from "@/lib/labels";
import {
  canCombine,
  COMBINE,
  defaultChoice,
  defaultTitleChoice,
  isMergeable,
  makesBlockerLoop,
  makesParentLoop,
  MAX_MERGE_ROWS,
  MERGE_TITLE,
  MergeChoiceError,
  mergedValues,
  MIN_MERGE_ROWS,
  pairedValue,
  repointedValue,
  type MergeChoices,
  type MergeRow,
} from "@/lib/merge-rows";
import { assertPageUnlocked } from "@/lib/page-lock";
import { PropertyValueError } from "@/lib/properties";
import { atLeast } from "@/lib/property-access";
import type { PropertyType } from "@/lib/property-types";
import { resolveValue, type ActivityValue } from "@/lib/row-activity";
import { parentProperty } from "@/lib/sub-items";
import { AccessError, accessRank, getMembership, hasLevel, isGuest, levelFromRank, pageVisibleTo } from "@/server/access";
import { loadLookups } from "@/server/activity-lookups";
import { recordAudit } from "@/server/audit";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { afterRowWrites, getProperties, notifyRows, requireDatabase, withCode, type DatabaseProperty } from "@/server/databases";
import { savedLocale } from "@/server/mail/locale";
import { lockLiveParent, renamePage } from "@/server/pages";
import { propertyAccessFor, type PropertyAccess } from "@/server/property-access";
import { moveMergedActivity } from "@/server/row-activity";
import { rowChanged } from "@/server/row-events";
import { searchFoldSql } from "@/server/search-fold-sql";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type MergeRowsInput = {
  /** The row that stays. */
  keptRowId: string;
  /** The rows merged into it, which go to the trash (1 to MAX_MERGE_ROWS - 1 of them). */
  otherRowIds: string[];
  /** Which row's value each property (by id, or MERGE_TITLE) takes, or COMBINE; defaults for the rest. */
  choices?: MergeChoices;
};

type StoredRow = {
  id: string;
  title: string;
  icon: string | null;
  kind: "page" | "database";
  parentId: string | null;
  workspaceId: string;
  properties: RowProperties;
  createdAt: Date;
  createdBy: string | null;
  archivedAt: Date | null;
  lockedAt: Date | null;
  isTemplate: boolean;
  inTemplate: boolean;
  level: number;
};

const rowColumns = (userId: string) => ({
  id: page.id,
  title: page.title,
  icon: page.icon,
  kind: page.kind,
  parentId: page.parentId,
  workspaceId: page.workspaceId,
  properties: page.properties,
  createdAt: page.createdAt,
  createdBy: page.createdBy,
  archivedAt: page.archivedAt,
  lockedAt: page.lockedAt,
  isTemplate: page.isTemplate,
  inTemplate: page.inTemplate,
  level: accessRank(userId, sql`${page.id}`),
});

/** Locks the rows (by id, always in the same order, so two merges never wait for each other in turn). */
async function lockRows(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  await tx.execute(sql`select id from ${page} where ${inArray(page.id, ids)} order by id for update`);
}

/** Titles for an error, as the user may see them; the rest counted. */
function rowNames(rows: { title: string; level: number }[]) {
  const seen = rows.filter((r) => hasLevel(levelFromRank(r.level), "view")).map((r) => `“${pageLabel(r.title)}”`);
  const hidden = rows.length - seen.length;
  return { names: seen.join(", "), hidden };
}

const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const sameIds = (a: unknown, b: unknown) => JSON.stringify(idsOf(a)) === JSON.stringify(idsOf(b));

/** The rows of a merge, checked: rows of one database, live, that the user may edit. Kept first. */
async function loadRows(exec: Executor, userId: string, input: MergeRowsInput) {
  const others = [...new Set(input.otherRowIds)].filter((id) => id !== input.keptRowId);
  const ids = [input.keptRowId, ...others];
  if (ids.length < MIN_MERGE_ROWS || ids.length > MAX_MERGE_ROWS || others.length !== input.otherRowIds.length) {
    throw new PropertyValueError(`Merge ${MIN_MERGE_ROWS} to ${MAX_MERGE_ROWS} different rows: the kept row and the rows merged into it`, "mergeRowCount", {
      min: String(MIN_MERGE_ROWS),
      max: String(MAX_MERGE_ROWS),
    });
  }
  const found = (await exec.select(rowColumns(userId)).from(page).where(inArray(page.id, ids))) as StoredRow[];
  const byId = new Map(found.map((r) => [r.id, r] as const));
  // Rows that don't exist and rows the user can't see read alike.
  if (ids.some((id) => !byId.has(id) || !hasLevel(levelFromRank(byId.get(id)!.level), "view"))) throw new AccessError();
  const rows = ids.map((id) => byId.get(id)!);
  const databaseId = rows[0].parentId;
  if (!databaseId || rows.some((r) => r.parentId !== databaseId)) {
    throw new PropertyValueError("Only rows of one database can be merged", "mergeRowsInvalid");
  }
  const database = await requireDatabase(userId, databaseId, "view");
  const membership = await getMembership(userId, database.workspaceId);
  // As in the bulk bar, which leaves the trash out for guests.
  if (!membership || isGuest(membership.role)) throw new AccessError("Guests can't merge rows");
  if (rows.some((r) => r.archivedAt || r.isTemplate)) {
    throw new PropertyValueError("Rows in the trash and row templates can't be merged", "mergeRowsInvalid");
  }
  const readOnly = rows.filter((r) => !hasLevel(levelFromRank(r.level), "content"));
  if (readOnly.length) {
    throw new PropertyValueError(`You can only view ${rowNames(readOnly).names}: merging needs edit access to every row`, "mergeRowsReadOnly", {
      rows: rowNames(readOnly).names,
    });
  }
  // Its title and body change: a locked row stays as it is.
  assertPageUnlocked(rows[0]);
  return { database, kept: rows[0], merged: rows.slice(1), rows };
}

/** What the user may do with the kept row's properties, and see of each row's (property access). */
function accessRules(access: PropertyAccess, rows: StoredRow[], keptId: string) {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return {
    canEdit: (propertyId: string, rowId = keptId) => atLeast(access.levelOf(propertyId, byId.get(rowId)), "edit_values"),
    sees: (propertyId: string, rowId: string) => atLeast(access.levelOf(propertyId, byId.get(rowId)), "view"),
  };
}

const asMergeRows = (rows: StoredRow[]): MergeRow[] =>
  rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, properties: r.properties }));

/** A change of another row's links: its values before and after. */
type LinkChange = { rowId: string; databaseId: string; title: string; level: number; before: RowProperties; after: RowProperties };

/**
 * Works out the merge without writing anything: the kept row's values, the other rows whose links
 * change and how, and what the merged rows keep. Refuses a merge the user may not make, or one
 * that would put a row under itself or make it wait for itself. With `tx`, every row read is
 * locked first, so what is written is what was read.
 */
async function planMerge(exec: Executor, userId: string, input: MergeRowsInput, tx?: Tx) {
  if (tx) await lockRows(tx, [input.keptRowId, ...input.otherRowIds]);
  const { database, kept, merged, rows } = await loadRows(exec, userId, input);
  const databaseId = database.id;
  // The database can't go to the trash while its rows are merged.
  if (tx) await lockLiveParent(tx, databaseId);
  const properties = await getProperties(databaseId);
  const access = await propertyAccessFor(userId, databaseId);
  const rules = accessRules(access, rows, kept.id);

  let values;
  try {
    values = mergedValues({
      databaseId,
      keptId: kept.id,
      rows: asMergeRows(rows),
      properties,
      choices: input.choices ?? {},
      canEdit: (propertyId) => rules.canEdit(propertyId),
      sees: rules.sees,
    });
  } catch (error) {
    if (error instanceof MergeChoiceError) throw new PropertyValueError(error.message, "mergeChoiceInvalid", { property: error.property });
    throw error;
  }

  const mergedIds = new Set(merged.map((r) => r.id));
  const involved = new Set([kept.id, ...mergedIds]);
  // Two-way relations of this database, each with the property on the other side.
  const paired = new Map<string, DatabaseProperty>();
  for (const prop of properties) {
    const pairId = prop.type === "relation" ? prop.options.relation?.pairedPropertyId : null;
    if (pairId) paired.set(pairId, prop);
  }
  // Every live relation of the workspace that links to this database's rows.
  const linking = await exec
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId, options: databaseProperty.options })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(page.workspaceId, database.workspaceId),
        isNull(page.archivedAt),
        isNull(databaseProperty.deletedAt),
        eq(databaseProperty.type, "relation"),
        sql`${databaseProperty.options} -> 'relation' ->> 'databaseId' = ${databaseId}`,
      ),
    );

  const changes = new Map<string, LinkChange>();
  const linked = new Map<string, StoredRow>();
  for (const prop of linking) {
    // The other side of a two-way relation, when it is one: its kept value says what links back.
    const pair = paired.get(prop.id);
    const twoWay = pair && pair.options.relation?.pairedPropertyId === prop.id && pair.options.relation.databaseId === prop.databaseId;
    const listed = new Set(twoWay ? idsOf(values.properties[pair.id]) : []);
    const targets = twoWay ? [...involved] : [...mergedIds];
    const holds = sql`(${page.properties} -> ${prop.id}) ?| array[${sql.join(
      targets.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const found = await exec
      .select({ id: page.id })
      .from(page)
      .where(
        and(
          eq(page.parentId, prop.databaseId),
          isNull(page.archivedAt),
          eq(page.inTemplate, false),
          listed.size ? sql`(${holds} or ${inArray(page.id, [...listed])})` : holds,
        ),
      );
    const ids = found.map((r) => r.id).filter((id) => !involved.has(id) && !linked.has(id));
    if (ids.length) {
      if (tx) await lockRows(tx, ids);
      const read = (await exec.select(rowColumns(userId)).from(page).where(inArray(page.id, ids))) as StoredRow[];
      for (const row of read) linked.set(row.id, row);
    }
    for (const row of [...linked.values()].filter((r) => r.parentId === prop.databaseId)) {
      const change = changes.get(row.id) ?? {
        rowId: row.id,
        databaseId: prop.databaseId,
        title: row.title,
        level: row.level,
        before: row.properties,
        after: { ...row.properties },
      };
      const was = change.after[prop.id];
      const now = twoWay ? pairedValue(was, mergedIds, kept.id, listed.has(row.id)) : repointedValue(was, mergedIds, kept.id);
      if (sameIds(was, now)) continue;
      if (now.length) change.after[prop.id] = now;
      else delete change.after[prop.id];
      changes.set(row.id, change);
    }
  }

  // Every row whose links change must be the user's to edit, the changed values included.
  const blocked: LinkChange[] = [];
  const accessOf = new Map<string, PropertyAccess>([[databaseId, access]]);
  for (const change of changes.values()) {
    if (!hasLevel(levelFromRank(change.level), "content")) {
      blocked.push(change);
      continue;
    }
    const theirs = accessOf.get(change.databaseId) ?? (await propertyAccessFor(userId, change.databaseId));
    accessOf.set(change.databaseId, theirs);
    const changed = Object.keys({ ...change.before, ...change.after }).filter((k) => !sameIds(change.before[k], change.after[k]));
    if (changed.some((k) => !atLeast(theirs.levelOf(k, { properties: change.before, createdBy: linked.get(change.rowId)?.createdBy }), "edit_values"))) {
      blocked.push(change);
    }
  }
  if (blocked.length) {
    const { names, hidden } = rowNames(blocked);
    const rowsText = [names, hidden ? `${hidden} other ${hidden === 1 ? "row" : "rows"}` : ""].filter(Boolean).join(", ");
    throw new PropertyValueError(`These rows link to the rows being merged and you can't change them: ${rowsText}`, "mergeLinksBlocked", {
      rows: names || "—",
      count: String(blocked.length),
      hidden: String(hidden),
    });
  }

  // The merged rows let go of two-way links: those moved to the kept row (or were let go).
  const mergedAfter = new Map(
    merged.map((row) => {
      const after = { ...row.properties };
      for (const prop of properties) if (prop.options.relation?.pairedPropertyId) delete after[prop.id];
      return [row.id, after] as const;
    }),
  );

  await checkMergeLoops(databaseId, properties, kept.id, mergedIds, values.properties, changes);
  return { database, kept, merged, rows, properties, values, changes: [...changes.values()], mergedAfter, rules };
}

/** Refuses a merge that would put a row under itself (sub-items) or make it wait for itself (dependencies). */
async function checkMergeLoops(
  databaseId: string,
  properties: DatabaseProperty[],
  keptId: string,
  mergedIds: ReadonlySet<string>,
  keptAfter: RowProperties,
  changes: Map<string, LinkChange>,
) {
  const parent = parentProperty(properties);
  const blockedBy = blockedByProperty(properties);
  if (!parent && !blockedBy) return;
  const rows = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(and(eq(page.parentId, databaseId), isNull(page.archivedAt), eq(page.isTemplate, false)));
  const after = (row: { id: string; properties: RowProperties }) =>
    row.id === keptId ? keptAfter : (changes.get(row.id)?.after ?? row.properties);
  const live = rows.filter((r) => !mergedIds.has(r.id));
  const starts = [keptId, ...[...changes.values()].filter((c) => c.databaseId === databaseId).map((c) => c.rowId)];
  if (parent) {
    const parents = new Map(live.map((r) => [r.id, idsOf(after(r)[parent.id])[0] ?? null] as const));
    if (makesParentLoop(parents, starts)) {
      throw new PropertyValueError(`"${parent.name}" can't put a row under itself or under one of its own sub-items`, "subItemLoop", { property: parent.name });
    }
  }
  if (blockedBy) {
    const blockers = new Map(live.map((r) => [r.id, idsOf(after(r)[blockedBy.id])] as const));
    if (makesBlockerLoop(blockers, starts)) {
      throw new PropertyValueError(`"${blockedBy.name}" can't make a row wait for itself or for a row waiting for it`, "dependencyLoop", {
        property: blockedBy.name,
      });
    }
  }
}

/**
 * The headings merged rows' bodies go under in the kept row, in the merger's language: the one their
 * app is in when they merge from it (`locale`), else the one they saved, else the default.
 */
async function mergedHeadings(userId: string, titles: string[], locale: Locale | undefined) {
  const messages = await loadMessages(locale ?? (await savedLocale(userId)) ?? DEFAULT_LOCALE);
  return titles.map((title) => messages.database.merge.bodyHeading.replace("{title}", pageLabel(title, messages.common.untitled)));
}

export type MergeResult = {
  databaseId: string;
  workspaceId: string;
  keptRowId: string;
  mergedRowIds: string[];
  title: string;
  /** Other rows whose links moved to the kept row. */
  relinkedRows: number;
  /** Comment threads, bodies, activity entries, uploads and emails that came along. */
  threads: number;
  bodies: number;
  activity: number;
  files: number;
  emails: number;
};

/**
 * Merges `otherRowIds` into `keptRowId` (see the top of this file). `dryRun` checks everything and
 * returns what would happen, writing nothing.
 */
export async function mergeRows(
  actor: WriteActor,
  input: MergeRowsInput,
  { dryRun = false, locale }: { dryRun?: boolean; locale?: Locale } = {},
): Promise<MergeResult> {
  const { userId } = actor;
  if (dryRun) {
    const plan = await planMerge(db, userId, input);
    const counts = await movedCounts(plan.merged.map((r) => r.id));
    return {
      databaseId: plan.database.id,
      workspaceId: plan.database.workspaceId,
      keptRowId: plan.kept.id,
      mergedRowIds: plan.merged.map((r) => r.id),
      title: plan.values.title,
      relinkedRows: plan.changes.length,
      threads: (await Promise.all(plan.merged.map((r) => getCollab().readThreads(r.id)))).flat().length,
      bodies: counts.bodies,
      activity: counts.activity,
      files: counts.files,
      emails: counts.emails,
    };
  }

  const archivedAt = new Date();
  const { plan, moved, trashed } = await db.transaction(async (tx) => {
    const plan = await planMerge(tx, userId, input, tx);
    const keptId = plan.kept.id;
    const mergedIds = plan.merged.map((r) => r.id);
    const moved = await movedCounts(mergedIds, tx);

    for (const change of plan.changes) {
      await tx.update(page).set({ properties: sql`${JSON.stringify(change.after)}::jsonb`, updatedBy: userId }).where(eq(page.id, change.rowId));
    }
    for (const [id, properties] of plan.mergedAfter) {
      await tx
        .update(page)
        .set({ properties: sql`${JSON.stringify(properties)}::jsonb`, mergedIntoId: keptId, updatedBy: userId })
        .where(eq(page.id, id));
    }
    // Rows merged into these before now resolve to the kept row in one step.
    await tx.update(page).set({ mergedIntoId: keptId }).where(inArray(page.mergedIntoId, mergedIds));
    // To the trash with the pages inside them, as archiveRows puts rows there: each its own entry.
    const trashed = await tx
      .update(page)
      .set({ archivedAt, updatedBy: userId })
      .where(
        and(
          sql`${page.id} in (
            with recursive sub as (
              select id from ${page} where ${inArray(page.id, mergedIds)}
              union all
              select p.id from ${page} p join sub on p.parent_id = sub.id
            ) select id from sub
          )`,
          isNull(page.archivedAt),
        ),
      )
      .returning({ id: page.id });
    // The kept row's values once the merged rows are in the trash: a value kept unique
    // (lib/unique-values) may come from one of them.
    await tx
      .update(page)
      .set({ properties: sql`${JSON.stringify(plan.values.properties)}::jsonb`, updatedBy: userId })
      .where(eq(page.id, keptId));

    await moveMergedActivity(tx, {
      workspaceId: plan.database.workspaceId,
      databaseId: plan.database.id,
      keptId,
      merged: plan.merged.map((r) => ({ id: r.id, title: r.title })),
      actorId: userId,
    });
    await tx.update(rowEmail).set({ rowId: keptId }).where(inArray(rowEmail.rowId, mergedIds));
    // Uploads to a merged row count as the kept row's: they live on with it (see server/files.ts).
    await tx.update(file).set({ pageId: keptId }).where(inArray(file.pageId, mergedIds));
    // Followers, muted threads, reminders and mentions already seen come along; the kept row's own win.
    await tx.execute(sql`
      insert into ${rowFollower} (row_id, user_id, following, updated_at)
      select ${keptId}, user_id, following, updated_at from ${rowFollower} where ${inArray(rowFollower.rowId, mergedIds)}
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into ${threadMute} (page_id, thread_id, user_id, created_at)
      select ${keptId}, thread_id, user_id, created_at from ${threadMute} where ${inArray(threadMute.pageId, mergedIds)}
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into ${pageMention} (page_id, mention_id, user_id, created_at)
      select ${keptId}, mention_id, user_id, created_at from ${pageMention} where ${inArray(pageMention.pageId, mergedIds)}
      on conflict do nothing
    `);
    // One reminder per date mention: the kept row's own, else the first merged row's.
    await tx.execute(sql`
      update ${pageReminder} set page_id = ${keptId}
      where id in (
        select distinct on (r.mention_id) r.id from ${pageReminder} r
        where ${inArray(sql`r.page_id`, mergedIds)} and r.notified_at is null
          and not exists (select 1 from ${pageReminder} k where k.page_id = ${keptId} and k.mention_id = r.mention_id)
        order by r.mention_id, r.created_at
      )
    `);
    await tx.execute(sql`
      insert into ${pageFavorite} (user_id, page_id, created_at)
      select user_id, ${keptId}, created_at from ${pageFavorite} where ${inArray(pageFavorite.pageId, mergedIds)}
      on conflict do nothing
    `);
    return { plan, moved, trashed: trashed.map((t) => t.id) };
  });

  const keptId = plan.kept.id;
  const databaseId = plan.database.id;
  const collab = getCollab();
  // Open editors of the merged rows stop writing at once, as for any row put in the trash.
  await collab.pagesTrashed(trashed, true);
  let carried = { bodies: 0, threads: 0 };
  if (plan.values.title !== plan.kept.title) {
    try {
      await renamePage(actor, keptId, plan.values.title);
    } catch (error) {
      console.error("[merge-rows] renaming the kept row failed", error);
    }
  }
  try {
    const headings = await mergedHeadings(userId, plan.merged.map((row) => row.title), locale);
    const sources = plan.merged.map((row, i) => ({ pageId: row.id, title: pageLabel(row.title), heading: headings[i] }));
    carried = await collab.mergeInto(keptId, sources, actor);
  } catch (error) {
    // The merge stands; what didn't come along is still in the merged rows, in the trash.
    console.error("[merge-rows] carrying bodies and comments over failed", error);
  }

  await afterRowWrites(userId, databaseId, [{ rowId: keptId, before: plan.kept.properties, after: plan.values.properties }]);
  await recordAudit({
    workspaceId: plan.database.workspaceId,
    actorId: userId,
    action: "page.rows_merged",
    target: { type: "page", id: keptId, label: plan.values.title },
    details: { count: plan.merged.length, names: plan.merged.map((r) => pageLabel(r.title)), database: plan.database.title },
  });

  const touched = new Set([databaseId, ...plan.changes.map((c) => c.databaseId)]);
  for (const id of touched) notifyRows(id);
  for (const change of plan.changes) rowChanged({ rowId: change.rowId, databaseId: change.databaseId, userId });
  rowChanged({ rowId: keptId, databaseId, userId });
  collab.broadcast(`ws:${plan.database.workspaceId}`, "tree");

  return {
    databaseId,
    workspaceId: plan.database.workspaceId,
    keptRowId: keptId,
    mergedRowIds: plan.merged.map((r) => r.id),
    title: plan.values.title,
    relinkedRows: plan.changes.length,
    threads: carried.threads,
    bodies: carried.bodies,
    activity: moved.activity,
    files: moved.files,
    emails: moved.emails,
  };
}

/** How much of what the rows hold comes along when they are merged. */
async function movedCounts(rowIds: string[], exec: Executor = db) {
  if (!rowIds.length) return { activity: 0, files: 0, emails: 0, bodies: 0 };
  const [[activity], [files], [emails], [bodies]] = await Promise.all([
    exec.select({ n: count() }).from(rowActivity).where(inArray(rowActivity.rowId, rowIds)),
    exec.select({ n: count() }).from(file).where(inArray(file.pageId, rowIds)),
    exec.select({ n: count() }).from(rowEmail).where(inArray(rowEmail.rowId, rowIds)),
    exec.select({ n: count() }).from(page).where(and(inArray(page.id, rowIds), sql`${page.contentText} <> ''`)),
  ]);
  return { activity: activity.n, files: files.n, emails: emails.n, bodies: bodies.n };
}

// ----------------------------------------------------------------------------------- the dialog

export type MergePreviewProperty = {
  id: string;
  name: string;
  type: PropertyType;
  /** It offers "combine all". */
  combinable: boolean;
  /** Each row's value as it reads; null where the user may not see it. */
  values: Record<string, ActivityValue | null>;
  /** Whether the user may change it in each row, were that row kept (property access). */
  editable: Record<string, boolean>;
};

export type MergePreview = {
  databaseId: string;
  rows: {
    id: string;
    title: string;
    icon: string | null;
    createdAt: string;
    /** What would come along from it, were it merged into another row. */
    carries: { threads: number; activity: number; files: number; emails: number; links: number; body: boolean; subpages: number };
  }[];
  properties: MergePreviewProperty[];
  /** The choices each row starts with, were it kept. */
  defaults: Record<string, MergeChoices>;
};

/**
 * What the merge dialog shows for these rows: their values as the user may see them, which ones
 * they may change, the choices each row starts with were it the one kept, and what each would
 * bring along. Checks the rows as a merge does (but not the rows linking to them: the merge says).
 */
export async function previewMerge(userId: string, rowIds: string[]): Promise<MergePreview> {
  const [first, ...rest] = [...new Set(rowIds)];
  const loaded = await loadRows(db, userId, { keptRowId: first ?? "", otherRowIds: rest });
  const { database } = loaded;
  // Oldest first: the row kept unless the user picks another, then the order values are taken in.
  const rows = [...loaded.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const properties = (await getProperties(database.id)).filter(isMergeable);
  const access = await propertyAccessFor(userId, database.id);
  const visible = new Set(access.visible(properties).map((p) => p.id));
  const shown = properties.filter((p) => visible.has(p.id));
  const rules = accessRules(access, rows, rows[0].id);
  const merging = asMergeRows(rows);
  const ids = rows.map((r) => r.id);

  const people = new Set<string>();
  const pages = new Set<string>();
  for (const prop of shown) {
    for (const row of rows) {
      if (!rules.sees(prop.id, row.id)) continue;
      const value = idsOf(row.properties[prop.id]);
      if (prop.type === "person") value.forEach((id) => people.add(id));
      if (prop.type === "relation") value.forEach((id) => pages.add(id));
    }
  }
  const lookups = await loadLookups(userId, [...people], [...pages]);

  const defaults: Record<string, MergeChoices> = {};
  for (const keptId of ids) {
    const choices: MergeChoices = { [MERGE_TITLE]: defaultTitleChoice(merging, keptId) };
    for (const prop of shown) {
      choices[prop.id] = rules.canEdit(prop.id, keptId) ? defaultChoice(prop, merging, keptId, (rowId) => rules.sees(prop.id, rowId)) : keptId;
    }
    defaults[keptId] = choices;
  }

  const [threads, counts, links, subpages] = await Promise.all([
    Promise.all(rows.map((r) => getCollab().readThreads(r.id))),
    Promise.all(rows.map((r) => movedCounts([r.id]))),
    linkCounts(database.workspaceId, database.id, ids),
    db
      .select({ parentId: page.parentId, n: count() })
      .from(page)
      .where(and(inArray(page.parentId, ids), isNull(page.archivedAt)))
      .groupBy(page.parentId),
  ]);

  return {
    databaseId: database.id,
    rows: rows.map((r, i) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      createdAt: r.createdAt.toISOString(),
      carries: {
        threads: threads[i].length,
        activity: counts[i].activity,
        files: counts[i].files,
        emails: counts[i].emails,
        links: links.get(r.id) ?? 0,
        body: counts[i].bodies > 0,
        subpages: subpages.find((s) => s.parentId === r.id)?.n ?? 0,
      },
    })),
    properties: shown.map((prop) => ({
      id: prop.id,
      name: prop.name,
      type: prop.type,
      combinable: canCombine(prop),
      values: Object.fromEntries(
        rows.map((r) => [
          r.id,
          rules.sees(prop.id, r.id) ? resolveValue(prop.type, prop.options.options ?? [], r.properties[prop.id], lookups) : null,
        ]),
      ),
      editable: Object.fromEntries(ids.map((id) => [id, rules.canEdit(prop.id, id)])),
    })),
    defaults,
  };
}

/** How many live rows link to each of these rows, through any relation of the workspace. */
async function linkCounts(workspaceId: string, databaseId: string, rowIds: string[]) {
  const found = await db.execute<{ target: string; n: number }>(sql`
    select t.target, count(distinct r.id)::int as n
    from ${databaseProperty} dp
    join ${page} d on d.id = dp.database_id and d.workspace_id = ${workspaceId} and d.archived_at is null
    join ${page} r on r.parent_id = dp.database_id and r.archived_at is null and not r.in_template
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.properties -> dp.id) = 'array' then r.properties -> dp.id else '[]'::jsonb end) as t(target)
    where dp.type = 'relation' and dp.deleted_at is null and dp.options -> 'relation' ->> 'databaseId' = ${databaseId}
      and ${inArray(sql`t.target`, rowIds)} and not (${inArray(sql`r.id`, rowIds)})
    group by t.target
  `);
  return new Map([...found].map((r) => [r.target, Number(r.n)] as const));
}

/** A row "Merge with…" offers: one of the same database the user may edit. */
export type MergeCandidate = { id: string; title: string; icon: string | null; createdAt: string };

/** Rows offered at once, at most. */
const MERGE_CANDIDATES = 20;

/**
 * Rows of `rowId`'s database the user could merge it with, whose title holds `query` (any row
 * when it's empty): live, not templates, editable, newest first.
 */
export async function mergeCandidates(userId: string, rowId: string, query: string): Promise<MergeCandidate[]> {
  const [row] = (await db.select(rowColumns(userId)).from(page).where(eq(page.id, rowId))) as StoredRow[];
  if (!row || !hasLevel(levelFromRank(row.level), "view") || !row.parentId) throw new AccessError();
  await requireDatabase(userId, row.parentId, "view");
  const q = query.trim().slice(0, 200);
  const found = (await db
    .select(rowColumns(userId))
    .from(page)
    .where(
      and(
        eq(page.parentId, row.parentId),
        ne(page.id, rowId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        pageVisibleTo(userId),
        q ? sql`${searchFoldSql(page.title)} like '%' || ${searchFoldSql(q)} || '%'` : undefined,
      ),
    )
    .orderBy(desc(page.createdAt))
    .limit(MERGE_CANDIDATES * 3)) as StoredRow[];
  return found
    .filter((r) => hasLevel(levelFromRank(r.level), "content"))
    .slice(0, MERGE_CANDIDATES)
    .map((r) => ({ id: r.id, title: r.title, icon: r.icon, createdAt: r.createdAt.toISOString() }));
}

export { COMBINE, MERGE_TITLE, MAX_MERGE_ROWS, MIN_MERGE_ROWS, withCode };
