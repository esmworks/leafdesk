/**
 * Versions of an agent's setup (lib/agent-versions; version-record.ts keeps them as people save):
 * anyone the agent is shared with lists its versions and sees how one differs from its setup now;
 * those who can edit it bring one back.
 *
 * Restoring goes through the functions a person's own changes do (they check access, skills and
 * limits and write the audit log), skips what can't come back any more and says so, and makes a
 * version of its own ("restored").
 */
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { agentSkill, agentVersion, page, user, workspaceAgent } from "@/db/schema";
import {
  AGENT_SETTINGS_LEFT_OUT,
  canonical,
  diffSnapshots,
  pairSchedules,
  parseSnapshot,
  scheduleContent,
  settingsOf,
  type AgentRestoreResult,
  type AgentRestoreSkip,
  type AgentRestoreSkipReason,
  type AgentVersionDetail,
  type AgentVersionView,
  type SnapshotSchedule,
  type VersionPageRef,
  type VersionScheduleRef,
} from "@/lib/agent-versions";
import { MAX_AGENT_DESCRIPTION, MAX_AGENT_INSTRUCTIONS, MAX_AGENT_NAME, MAX_AGENT_SKILLS, MAX_AGENT_TOKEN_LIMIT } from "@/lib/agents";
import { parseIcon } from "@/lib/icon";
import { AccessError, ConnectedAppReadOnlyError, pageVisibleTo } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { PermissionError } from "@/server/permissions";
import { AgentError, agentFor, agentWithLevel, auditDetails, removeAgentAccess, setAgentAccess } from "./manage";
import { removeAgentSchedule, setAgentSchedule } from "./schedules";
import { addAgentSkill, removeAgentSkill } from "./skills";
import { agentColumns, agentSettings, readSnapshot, saveVersion, withoutVersions, type Agent, type AgentVersionRow } from "./version-record";

async function viewVersions(rows: Omit<AgentVersionRow, "snapshot">[]): Promise<AgentVersionView[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))];
  const names = new Map(ids.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map((u) => [u.id, u.name]) : []);
  return rows.map((r) => ({
    number: r.number,
    kind: r.kind,
    changes: r.changes ?? null,
    restoredFrom: r.restoredFrom,
    by: r.createdBy ? { id: r.createdBy, name: names.get(r.createdBy) ?? "" } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** The agent's versions, newest first, without their setups, for anyone the agent is shared with. */
export async function listAgentVersions(userId: string, agentId: string): Promise<AgentVersionView[]> {
  const agent = await agentFor(userId, agentId, "interact");
  const { snapshot: _snapshot, ...columns } = getTableColumns(agentVersion);
  return viewVersions(await db.select(columns).from(agentVersion).where(eq(agentVersion.agentId, agent.id)).orderBy(desc(agentVersion.number)));
}

async function findVersion(agentId: string, number: number) {
  if (!Number.isInteger(number) || number < 1) throw new AgentError("versionNotFound", "Version not found");
  const [found] = await db
    .select()
    .from(agentVersion)
    .where(and(eq(agentVersion.agentId, agentId), eq(agentVersion.number, number)));
  if (!found) throw new AgentError("versionNotFound", "Version not found");
  return found;
}

/** The pages these ids name, for `userId`: those they can't open aren't named. */
async function pageRefs(userId: string, ids: string[]): Promise<(id: string) => VersionPageRef> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db.select({ id: page.id, title: page.title, icon: page.icon, archivedAt: page.archivedAt }).from(page).where(inArray(page.id, unique))
    : [];
  const visible = new Set(
    unique.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, unique), pageVisibleTo(userId)))).map((p) => p.id) : [],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  return (id) => {
    const row = found.get(id);
    if (!row) return { id, title: "", icon: null, hidden: false, trashed: false, gone: true };
    if (!visible.has(id)) return { id: "", title: "", icon: null, hidden: true, trashed: Boolean(row.archivedAt), gone: false };
    return { id, title: row.title, icon: row.icon, hidden: false, trashed: Boolean(row.archivedAt), gone: false };
  };
}

/** How version `number` of the agent differs from its setup now, from the version to now, for anyone the agent is shared with. */
export async function getAgentVersion(userId: string, agentId: string, number: number): Promise<AgentVersionDetail> {
  const agent = await agentFor(userId, agentId, "interact");
  const found = await findVersion(agent.id, number);
  const diff = diffSnapshots(parseSnapshot(found.snapshot), await readSnapshot(agent));
  const schedules = [...diff.schedules.added, ...diff.schedules.removed, ...diff.schedules.changed.flatMap((c) => [c.before, c.after])];
  const ref = await pageRefs(userId, [
    ...diff.skills.added,
    ...diff.skills.removed,
    ...[...diff.shares.added, ...diff.shares.removed, ...diff.shares.changed].map((s) => s.pageId),
    ...schedules.flatMap((s) => (s.databaseId ? [s.databaseId] : [])),
  ]);
  const scheduleRef = (s: SnapshotSchedule): VersionScheduleRef => {
    const database = s.databaseId ? ref(s.databaseId) : null;
    // The task may name what is in the database: only those who can open it read it.
    const taskHidden = Boolean(database?.hidden);
    return { rule: s.rule, timeZone: s.timeZone, task: taskHidden ? "" : s.task, taskHidden, database };
  };
  return {
    version: (await viewVersions([found]))[0],
    settings: diff.settings,
    skills: { added: diff.skills.added.map(ref), removed: diff.skills.removed.map(ref), reordered: diff.skills.reordered },
    schedules: {
      added: diff.schedules.added.map(scheduleRef),
      removed: diff.schedules.removed.map(scheduleRef),
      changed: diff.schedules.changed.map((c) => ({ before: scheduleRef(c.before), after: scheduleRef(c.after) })),
    },
    shares: {
      added: diff.shares.added.map((s) => ({ ...ref(s.pageId), level: s.level })),
      removed: diff.shares.removed.map((s) => ({ ...ref(s.pageId), level: s.level })),
      changed: diff.shares.changed.map((s) => ({ ...ref(s.pageId), before: s.before, after: s.after })),
    },
  };
}

// ---------------------------------------------------------------------------------- restoring

/** A setting's value from a snapshot as its column takes it now, or undefined when it can't. */
function settingValue(field: string, column: PgColumn, value: unknown): unknown {
  if (value === null) return column.notNull ? undefined : null;
  const text = (max: number) => (typeof value === "string" && value.length <= max ? value : undefined);
  // The settings an owner sets in the form are checked as updateAgent checks them.
  switch (field) {
    case "name":
      return typeof value === "string" && value.trim() ? text(MAX_AGENT_NAME) : undefined;
    case "description":
      return text(MAX_AGENT_DESCRIPTION);
    case "instructions":
      return text(MAX_AGENT_INSTRUCTIONS);
    case "icon":
      return parseIcon(value) ?? undefined;
    case "monthly_token_limit":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AGENT_TOKEN_LIMIT ? value : undefined;
  }
  // Others by their column's type (and choices, when it has them).
  if (column.enumValues?.length && !column.enumValues.includes(value as string)) return undefined;
  switch (column.dataType) {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "date": {
      const date = typeof value === "string" ? new Date(value) : null;
      return date && !Number.isNaN(date.getTime()) ? date : undefined;
    }
    default:
      return value;
  }
}

/** Errors a restore passes over (skipping that part), as the reason it gives; null for others. */
function skipReason(error: unknown): AgentRestoreSkipReason | null {
  if (error instanceof AgentError) {
    switch (error.code) {
      case "notASkill":
        return "notASkill";
      case "skillEditable":
        return "skillEditable";
      case "tooManySkills":
      case "tooManySchedules":
        return "tooMany";
      case "invalid":
        return "invalid";
      case "notAPage":
      case "notADatabase":
        return "noAccess";
      case "scheduleNotFound":
        return "gone";
      default:
        return null;
    }
  }
  if (error instanceof ConnectedAppReadOnlyError) return null;
  if (error instanceof AccessError || error instanceof PermissionError) return "noAccess";
  return null;
}

/** Brings back the settings of a snapshot; those gone or no longer valid are skipped. */
/** Settings only the workspace's owners change (see updateAgent): someone else's restore leaves them as they are. */
const OWNERS_SETTINGS: ReadonlySet<string> = new Set(["monthly_token_limit"]);

async function restoreSettings(agent: Agent, settings: Record<string, unknown>, skipped: AgentRestoreSkip[], owner: boolean) {
  const columns = new Map(agentColumns().map(([key, column]) => [column.name, { key, column }]));
  const now = agentSettings(agent);
  const changes: { field: string; key: keyof Agent; value: unknown }[] = [];
  for (const [field, value] of Object.entries(settings)) {
    if (AGENT_SETTINGS_LEFT_OUT.has(field)) continue;
    const found = columns.get(field);
    if (!found) {
      skipped.push({ part: "setting", name: field, reason: "gone" });
      continue;
    }
    const restored = settingValue(field, found.column, value);
    if (restored === undefined) skipped.push({ part: "setting", name: field, reason: "invalid" });
    else if (canonical(settingsOf({ [field]: restored })[field]) !== canonical(now[field])) {
      if (!owner && OWNERS_SETTINGS.has(field)) skipped.push({ part: "setting", name: field, reason: "noAccess" });
      else changes.push({ field, key: found.key, value: restored });
    }
  }
  if (!changes.length) return;
  const write = (list: typeof changes) =>
    db.transaction(async (tx) => {
      await tx
        .update(workspaceAgent)
        .set(Object.fromEntries(list.map((c) => [c.key, c.value])))
        .where(eq(workspaceAgent.id, agent.id));
      // Its name shows wherever its user does, as updateAgent keeps it.
      const name = list.find((c) => c.key === "name");
      if (name) await tx.update(user).set({ name: name.value as string }).where(eq(user.id, agent.userId));
    });
  try {
    await write(changes);
  } catch {
    // A value the database refuses now (a rule added since): the others still come back.
    for (const change of changes) await write([change]).catch(() => skipped.push({ part: "setting", name: change.field, reason: "invalid" }));
  }
}

/**
 * Brings version `number` of an agent back: its settings, skills (in their order), schedules and
 * the pages shared with it (not those deleted or in the trash since), each through the function an
 * owner's own change goes through, so what can't come back now (a page the owner can't share, a
 * skill others may edit) is skipped and listed. Run history, memory and usage stay as they are.
 * Makes a version ("restored") and records the restore in the audit log. For those who can edit the
 * agent, of one that isn't archived; a setting only owners change (its monthly token limit) comes
 * back only when an owner restores.
 */
export async function restoreAgentVersion(userId: string, agentId: string, number: number): Promise<AgentRestoreResult> {
  const { agent, owner } = await agentWithLevel(userId, agentId, "edit");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to bring back one of its versions");
  const found = await findVersion(agent.id, number);
  const target = parseSnapshot(found.snapshot);
  const current = await readSnapshot(agent);
  const skipped: AgentRestoreSkip[] = [];
  const pages = await pageRefs(userId, [...target.skills, ...target.shares.map((s) => s.pageId), ...target.schedules.flatMap((s) => (s.databaseId ? [s.databaseId] : []))]);
  const missing = (pageId: string): AgentRestoreSkipReason | null => (pages(pageId).gone ? "gone" : pages(pageId).trashed ? "trash" : null);
  /** One step of the restore; one that can't be done now is skipped and listed. */
  const step = async (part: AgentRestoreSkip["part"], name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      const reason = skipReason(error);
      if (!reason) throw error;
      skipped.push({ part, name, reason });
    }
  };

  await withoutVersions(async () => {
    await restoreSettings(agent, target.settings, skipped, owner);

    // Skills: those it no longer had go first, leaving room; then the order is set.
    for (const pageId of current.skills.filter((id) => !target.skills.includes(id))) await removeAgentSkill(userId, agent.id, pageId);
    for (const pageId of target.skills.slice(0, MAX_AGENT_SKILLS).filter((id) => !current.skills.includes(id))) {
      const gone = missing(pageId);
      if (gone) skipped.push({ part: "skill", name: pages(pageId).title, reason: gone });
      else await step("skill", pages(pageId).title, () => addAgentSkill(userId, agent.id, pageId));
    }
    await db.transaction(async (tx) => {
      for (const [position, pageId] of target.skills.entries()) {
        await tx
          .update(agentSkill)
          .set({ position })
          .where(and(eq(agentSkill.agentId, agent.id), eq(agentSkill.pageId, pageId)));
      }
    });

    // Schedules: those it didn't have removed, kept ones set as they were, the ones it no longer has made again.
    const { pairs, removed, added } = pairSchedules(current.schedules, target.schedules);
    const label = (s: SnapshotSchedule) => (s.databaseId && pages(s.databaseId).hidden ? "" : s.task.slice(0, 80));
    const input = (s: SnapshotSchedule) => ({ rule: s.rule, timeZone: s.timeZone, task: s.task, databaseId: s.databaseId });
    for (const s of removed) await step("schedule", label(s), () => removeAgentSchedule(userId, agent.id, s.id));
    for (const [now, then] of pairs) {
      if (scheduleContent(now) !== scheduleContent(then)) await step("schedule", label(then), () => setAgentSchedule(userId, agent.id, now.id, input(then)));
    }
    for (const s of added) {
      const gone = s.databaseId ? missing(s.databaseId) : null;
      if (gone) skipped.push({ part: "schedule", name: label(s), reason: gone });
      else await step("schedule", label(s), () => setAgentSchedule(userId, agent.id, null, input(s)));
    }

    // Pages: shared again at the level they had, while they exist and aren't in the trash.
    const levels = new Map(current.shares.map((s) => [s.pageId, s.level]));
    const wanted = new Set(target.shares.map((s) => s.pageId));
    for (const s of current.shares.filter((c) => !wanted.has(c.pageId))) {
      await step("share", pages(s.pageId).title, () => removeAgentAccess(userId, agent.id, s.pageId));
    }
    for (const s of target.shares) {
      if (levels.get(s.pageId) === s.level) continue;
      const gone = missing(s.pageId);
      if (gone) skipped.push({ part: "share", name: pages(s.pageId).title, reason: gone });
      else await step("share", pages(s.pageId).title, () => setAgentAccess(userId, agent.id, s.pageId, s.level));
    }
  });

  const version = await saveVersion(userId, agent.id, { kind: "restored", restoredFrom: found.number });
  if (!version) throw new AgentError("notFound", "Agent not found");
  const [after] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, agent.id));
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: after.name },
    details: { ...auditDetails(after), previous: auditDetails(agent), restoredVersion: found.number, skipped: skipped.length || undefined },
  });
  return { version: (await viewVersions([version]))[0], skipped };
}
