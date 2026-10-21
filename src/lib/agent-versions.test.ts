import { describe, expect, it } from "vitest";
import {
  AGENT_VERSION_MERGE_MS,
  canonical,
  changedParts,
  diffSnapshots,
  fieldLabel,
  instructionChanges,
  mergesInto,
  parseSnapshot,
  sameSnapshot,
  settingsOf,
  type AgentSnapshot,
  type SnapshotSchedule,
} from "./agent-versions";
import type { RepeatRule } from "./schedule";

const daily = { frequency: "daily", interval: 1, time: "08:00", start: "2026-10-01" } as unknown as RepeatRule;
const schedule = (id: string, task: string, rule = daily): SnapshotSchedule => ({ id, rule, timeZone: "Europe/Istanbul", task, databaseId: null });

const base: AgentSnapshot = {
  settings: { name: "Router", icon: null, description: "", instructions: "Sort tickets.\nBe brief.", enabled: true, monthly_token_limit: null },
  skills: ["skill-a", "skill-b"],
  schedules: [schedule("s-1", "Weekly report")],
  shares: [
    { pageId: "p-1", level: "view" },
    { pageId: "p-2", level: "edit" },
  ],
};

describe("an agent's settings in a snapshot", () => {
  it("keep every column of its setup, a new one too, and leave out who, where, when and archiving", () => {
    const at = new Date("2026-10-01T10:00:00Z");
    expect(
      settingsOf({
        id: "a-1",
        workspace_id: "w",
        user_id: "u",
        created_by: "o",
        created_at: at,
        updated_at: at,
        archived_at: null,
        name: "Router",
        model: "small",
        web_access: false,
        paused_until: at,
      }),
    ).toEqual({ name: "Router", model: "small", web_access: false, paused_until: "2026-10-01T10:00:00.000Z" });
  });

  it("compare whatever order their keys were stored in", () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(sameSnapshot(base, parseSnapshot(JSON.parse(JSON.stringify(base))))).toBe(true);
  });
});

describe("reading a stored snapshot", () => {
  it("leaves out what isn't in the expected shape instead of failing", () => {
    const parsed = parseSnapshot({
      settings: { name: "X", id: "left-out" },
      skills: ["a", 3, "a", ""],
      schedules: [schedule("s-1", "T"), { id: "s-2" }, null],
      shares: [
        { pageId: "p-1", level: "full" },
        { pageId: "p-2", level: "comment" },
        { pageId: "p-2", level: "edit" },
      ],
    });
    expect(parsed).toEqual({ settings: { name: "X" }, skills: ["a"], schedules: [schedule("s-1", "T")], shares: [{ pageId: "p-2", level: "comment" }] });
    expect(parseSnapshot(null)).toEqual({ settings: {}, skills: [], schedules: [], shares: [] });
  });
});

describe("what differs between two setups", () => {
  it("names the settings that changed, then the parts", () => {
    const after: AgentSnapshot = {
      ...base,
      settings: { ...base.settings, instructions: "Sort tickets.", enabled: false },
      skills: ["skill-b", "skill-a"],
    };
    expect(changedParts(base, after)).toEqual(["instructions", "enabled", "skills"]);
    expect(changedParts(base, base)).toEqual([]);
    // A setting another version of the app added counts as a change.
    expect(changedParts(base, { ...base, settings: { ...base.settings, model: "large" } })).toEqual(["model"]);
  });

  it("tells skills added, removed and reordered apart", () => {
    expect(diffSnapshots(base, { ...base, skills: ["skill-b", "skill-c"] }).skills).toEqual({ added: ["skill-c"], removed: ["skill-a"], reordered: false });
    expect(diffSnapshots(base, { ...base, skills: ["skill-b", "skill-a"] }).skills).toEqual({ added: [], removed: [], reordered: true });
  });

  it("pairs schedules by id, and a schedule made again by what it does", () => {
    const weekly = { ...daily, frequency: "weekly", weekdays: [1] } as unknown as RepeatRule;
    const diff = diffSnapshots(
      { ...base, schedules: [schedule("s-1", "Weekly report"), schedule("s-2", "Tidy up"), schedule("s-3", "Gone")] },
      { ...base, schedules: [schedule("s-1", "Weekly report", weekly), schedule("s-9", "Tidy up"), schedule("s-4", "New")] },
    );
    expect(diff.schedules.changed).toEqual([{ before: schedule("s-1", "Weekly report"), after: schedule("s-1", "Weekly report", weekly) }]);
    expect(diff.schedules.removed.map((s) => s.id)).toEqual(["s-3"]);
    expect(diff.schedules.added.map((s) => s.id)).toEqual(["s-4"]);
    expect(changedParts(base, { ...base, schedules: [schedule("s-7", "Weekly report")] })).toEqual([]);
  });

  it("tells pages shared, unshared and shared at another level apart", () => {
    const diff = diffSnapshots(base, {
      ...base,
      shares: [
        { pageId: "p-2", level: "comment" },
        { pageId: "p-3", level: "view" },
      ],
    });
    expect(diff.shares).toEqual({
      added: [{ pageId: "p-3", level: "view" }],
      removed: [{ pageId: "p-1", level: "view" }],
      changed: [{ pageId: "p-2", before: "edit", after: "comment" }],
    });
  });

  it("shows instructions line by line, with the words changed inside a line", () => {
    const changes = instructionChanges("Sort tickets.\nBe brief.\nSign as Bot.", "Sort tickets.\nBe very brief.\nAsk first.\nSign as Bot.");
    expect(changes.map((c) => [c.op, c.block.text])).toEqual([
      ["same", "Sort tickets."],
      ["changed", "Be very brief."],
      ["added", "Ask first."],
      ["same", "Sign as Bot."],
    ]);
    const changed = changes[1];
    expect(changed.op === "changed" && changed.words.filter((w) => w.op === "add").map((w) => w.text.trim())).toEqual(["very"]);
    expect(instructionChanges("", "One line").map((c) => c.op)).toEqual(["added"]);
  });

  it("names a setting no translation knows by its column", () => {
    expect(fieldLabel("monthly_token_limit")).toBe("Monthly token limit");
    expect(fieldLabel("model")).toBe("Model");
  });
});

describe("the merge window", () => {
  const saved = new Date("2026-10-22T10:00:00Z");
  const latest = { kind: "changed" as const, createdBy: "u-1", updatedAt: saved };
  const after = (ms: number) => new Date(saved.getTime() + ms);

  it("adds a person's save to their latest change within two minutes of it", () => {
    expect(mergesInto(latest, "u-1", after(AGENT_VERSION_MERGE_MS - 1))).toBe(true);
    expect(mergesInto(latest, "u-1", after(AGENT_VERSION_MERGE_MS))).toBe(false);
  });

  it("makes a new version for someone else, or after the version the agent was made with, a restore or the first kept", () => {
    expect(mergesInto(latest, "u-2", after(1000))).toBe(false);
    expect(mergesInto(latest, null, after(1000))).toBe(false);
    for (const kind of ["created", "restored", "baseline"] as const) expect(mergesInto({ ...latest, kind }, "u-1", after(1000))).toBe(false);
  });
});
