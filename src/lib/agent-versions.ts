// Client-safe: shared by the agents' versions on the server (server/agents/versions.ts), the
// agent's History tab and MCP.

import { AGENT_ACCESS_LEVELS, type AgentAccessLevel } from "./agents";
import { diffBlocks, type BlockChange, type DiffBlock } from "./page-diff";
import type { RepeatRule } from "./schedule";

/**
 * Versions of an agent's setup: every saved change to its settings, skills, schedules or the pages
 * shared with it keeps the whole setup as it was after the change, so an owner can see what changed
 * and bring an earlier setup back. Runs, memory and usage aren't part of it.
 */

/** Versions kept per agent; older ones go. */
export const MAX_AGENT_VERSIONS = 50;
/** A person's saves this close to their previous one (on the same version) add to that version. */
export const AGENT_VERSION_MERGE_MS = 2 * 60_000;

/**
 * "created": the agent as it was made. "changed": a saved change. "restored": an earlier version
 * brought back. "baseline": the setup an agent had when versions began (it was made before).
 */
export type AgentVersionKind = "created" | "changed" | "restored" | "baseline";

export type SnapshotSchedule = { id: string; rule: RepeatRule; timeZone: string; task: string; databaseId: string | null };
export type SnapshotShare = { pageId: string; level: AgentAccessLevel };

export type AgentSnapshot = {
  /**
   * The agent's own settings: each column of its row by its SQL name, except those below, so a
   * column added later is kept without a change here.
   */
  settings: Record<string, unknown>;
  /** Its skills' page ids, in the order runs follow them. */
  skills: string[];
  /** Its schedules, oldest first, as set (not when they run next or why they paused). */
  schedules: SnapshotSchedule[];
  /** The pages its owners shared with it, by page id (not those automations shared with it). */
  shares: SnapshotShare[];
};

/** Columns of an agent that aren't its setup: who and where it is, when, and whether it's archived. */
export const AGENT_SETTINGS_LEFT_OUT: ReadonlySet<string> = new Set(["id", "workspace_id", "user_id", "created_by", "created_at", "updated_at", "archived_at"]);

/** The settings of an agent's row (keyed by SQL column name), as a snapshot keeps them. */
export function settingsOf(columns: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(columns)) {
    if (AGENT_SETTINGS_LEFT_OUT.has(name) || value === undefined) continue;
    settings[name] = value instanceof Date ? value.toISOString() : value;
  }
  return settings;
}

/** JSON with object keys sorted, so two values compare equal however their keys were ordered. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A stored snapshot read defensively (a backup can be edited): what isn't in the expected shape is
 * left out rather than failing.
 */
export function parseSnapshot(value: unknown): AgentSnapshot {
  const raw = isRecord(value) ? value : {};
  const skills = Array.isArray(raw.skills) ? [...new Set(raw.skills.filter((id): id is string => typeof id === "string" && id !== ""))] : [];
  const schedules = (Array.isArray(raw.schedules) ? raw.schedules : []).flatMap((s): SnapshotSchedule[] =>
    isRecord(s) && typeof s.id === "string" && isRecord(s.rule) && typeof s.timeZone === "string"
      ? [
          {
            id: s.id,
            rule: s.rule as RepeatRule,
            timeZone: s.timeZone,
            task: typeof s.task === "string" ? s.task : "",
            databaseId: typeof s.databaseId === "string" && s.databaseId ? s.databaseId : null,
          },
        ]
      : [],
  );
  const seen = new Set<string>();
  const shares = (Array.isArray(raw.shares) ? raw.shares : []).flatMap((s): SnapshotShare[] => {
    if (!isRecord(s) || typeof s.pageId !== "string" || seen.has(s.pageId)) return [];
    if (!(AGENT_ACCESS_LEVELS as readonly unknown[]).includes(s.level)) return [];
    seen.add(s.pageId);
    return [{ pageId: s.pageId, level: s.level as AgentAccessLevel }];
  });
  return { settings: isRecord(raw.settings) ? settingsOf(raw.settings) : {}, skills, schedules, shares };
}

export const sameSnapshot = (a: AgentSnapshot, b: AgentSnapshot) => canonical(a) === canonical(b);

/** What a schedule does, without its id: two schedules alike in this are the same schedule. */
export const scheduleContent = (s: SnapshotSchedule) => canonical({ rule: s.rule, timeZone: s.timeZone, task: s.task, databaseId: s.databaseId });

/**
 * Pairs the schedules of two setups: by id, then those left by what they do (a schedule brought
 * back is made again, with a new id). The rest were added or removed.
 */
export function pairSchedules(before: readonly SnapshotSchedule[], after: readonly SnapshotSchedule[]) {
  const pairs: [SnapshotSchedule, SnapshotSchedule][] = [];
  const afterLeft = new Map(after.map((s) => [s.id, s]));
  const beforeLeft: SnapshotSchedule[] = [];
  for (const s of before) {
    const same = afterLeft.get(s.id);
    if (same) {
      pairs.push([s, same]);
      afterLeft.delete(s.id);
    } else beforeLeft.push(s);
  }
  const removed: SnapshotSchedule[] = [];
  for (const s of beforeLeft) {
    const alike = [...afterLeft.values()].find((a) => scheduleContent(a) === scheduleContent(s));
    if (alike) {
      pairs.push([s, alike]);
      afterLeft.delete(alike.id);
    } else removed.push(s);
  }
  return { pairs, removed, added: [...afterLeft.values()] };
}

export type AgentSnapshotDiff = {
  /** Settings that differ, by SQL column name, in the order of the newer setup. */
  settings: { field: string; before: unknown; after: unknown }[];
  skills: { added: string[]; removed: string[]; reordered: boolean };
  schedules: { added: SnapshotSchedule[]; removed: SnapshotSchedule[]; changed: { before: SnapshotSchedule; after: SnapshotSchedule }[] };
  shares: { added: SnapshotShare[]; removed: SnapshotShare[]; changed: { pageId: string; before: AgentAccessLevel; after: AgentAccessLevel }[] };
};

/** What differs from `before` to `after`. */
export function diffSnapshots(before: AgentSnapshot, after: AgentSnapshot): AgentSnapshotDiff {
  const fields = [...new Set([...Object.keys(after.settings), ...Object.keys(before.settings)])];
  const settings = fields
    .filter((field) => canonical(before.settings[field]) !== canonical(after.settings[field]))
    .map((field) => ({ field, before: before.settings[field] ?? null, after: after.settings[field] ?? null }));

  const kept = after.skills.filter((id) => before.skills.includes(id));
  const skills = {
    added: after.skills.filter((id) => !before.skills.includes(id)),
    removed: before.skills.filter((id) => !after.skills.includes(id)),
    reordered: canonical(kept) !== canonical(before.skills.filter((id) => after.skills.includes(id))),
  };

  const { pairs, removed, added } = pairSchedules(before.schedules, after.schedules);
  const schedules = {
    added,
    removed,
    changed: pairs.filter(([b, a]) => scheduleContent(b) !== scheduleContent(a)).map(([b, a]) => ({ before: b, after: a })),
  };

  const levels = new Map(before.shares.map((s) => [s.pageId, s.level]));
  const now = new Map(after.shares.map((s) => [s.pageId, s.level]));
  const shares = {
    added: after.shares.filter((s) => !levels.has(s.pageId)),
    removed: before.shares.filter((s) => !now.has(s.pageId)),
    changed: after.shares.flatMap((s) => {
      const was = levels.get(s.pageId);
      return was && was !== s.level ? [{ pageId: s.pageId, before: was, after: s.level }] : [];
    }),
  };
  return { settings, skills, schedules, shares };
}

export const AGENT_VERSION_PARTS = ["skills", "schedules", "shares"] as const;

/** What differs between two setups, part by part: the settings that differ, then "skills", "schedules", "shares". */
export function changedParts(before: AgentSnapshot, after: AgentSnapshot): string[] {
  const diff = diffSnapshots(before, after);
  return [
    ...diff.settings.map((s) => s.field),
    ...(diff.skills.added.length || diff.skills.removed.length || diff.skills.reordered ? ["skills"] : []),
    ...(diff.schedules.added.length || diff.schedules.removed.length || diff.schedules.changed.length ? ["schedules"] : []),
    ...(diff.shares.added.length || diff.shares.removed.length || diff.shares.changed.length ? ["shares"] : []),
  ];
}

/**
 * Whether a save by `userId` at `now` adds to the latest version instead of making one: it's a
 * plain change by the same person, saved last less than AGENT_VERSION_MERGE_MS before. The version
 * an agent was made with, one that brought another back and the first one kept stay as they are.
 */
export function mergesInto(latest: { kind: AgentVersionKind; createdBy: string | null; updatedAt: Date }, userId: string | null, now: Date) {
  return latest.kind === "changed" && userId !== null && latest.createdBy === userId && now.getTime() - latest.updatedAt.getTime() < AGENT_VERSION_MERGE_MS;
}

/** "monthly_token_limit" → "Monthly token limit": a setting no translation names yet. */
export function fieldLabel(field: string) {
  const words = field.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Instructions changed line by line (words marked inside a changed line), shown as the page history shows a page. */
export function instructionChanges(before: string, after: string): BlockChange[] {
  const lines = (text: string): DiffBlock[] => (text ? text.split("\n") : []).map((line) => ({ type: "paragraph", depth: 0, text: line, key: line }));
  return diffBlocks(lines(before), lines(after));
}

// ------------------------------------------------------------------------------------- views

export type AgentVersionView = {
  number: number;
  kind: AgentVersionKind;
  /** What differs from the version before it (changedParts); null when not known. */
  changes: string[] | null;
  restoredFrom: number | null;
  by: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

/** A page a version names, as the viewer may see it: one they can't open isn't named. */
export type VersionPageRef = { id: string; title: string; icon: string | null; hidden: boolean; trashed: boolean; gone: boolean };
export type VersionScheduleRef = { rule: RepeatRule; timeZone: string; task: string; taskHidden: boolean; database: VersionPageRef | null };

/** How a version differs from the agent's setup now, with pages named for the viewer. */
export type AgentVersionDetail = {
  version: AgentVersionView;
  /** Settings that differ (instructions too), from the version to now. */
  settings: { field: string; before: unknown; after: unknown }[];
  skills: { added: VersionPageRef[]; removed: VersionPageRef[]; reordered: boolean };
  schedules: { added: VersionScheduleRef[]; removed: VersionScheduleRef[]; changed: { before: VersionScheduleRef; after: VersionScheduleRef }[] };
  shares: {
    added: (VersionPageRef & { level: AgentAccessLevel })[];
    removed: (VersionPageRef & { level: AgentAccessLevel })[];
    changed: (VersionPageRef & { before: AgentAccessLevel; after: AgentAccessLevel })[];
  };
};

export const AGENT_RESTORE_SKIP_REASONS = ["gone", "trash", "invalid", "noAccess", "notASkill", "skillEditable", "tooMany"] as const;
export type AgentRestoreSkipReason = (typeof AGENT_RESTORE_SKIP_REASONS)[number];
/** A part of a version a restore couldn't bring back, and why; `name` is "" for a page the viewer can't open. */
export type AgentRestoreSkip = { part: "setting" | "skill" | "schedule" | "share"; name: string; reason: AgentRestoreSkipReason };

export type AgentRestoreResult = { version: AgentVersionView; skipped: AgentRestoreSkip[] };
