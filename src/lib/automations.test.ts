import { describe, expect, it } from "vitest";
import {
  changedProperties,
  dateCheckIntervalMs,
  datePassedCutoffs,
  datePassedFires,
  dateStart,
  isDynamicValue,
  matchesTrigger,
  runEvent,
  startPassed,
  statusMatch,
  statusMeets,
  trashProblem,
  retriable,
  retryDelayMs,
  runStatusOf,
  signatureHeader,
  signedContent,
  type AutomationStep,
} from "./automations";

const update = (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after, created: false });
const create = (after: Record<string, unknown>) => ({ before: {}, after, created: true });

describe("changedProperties", () => {
  it("lists properties added, removed and changed, comparing lists by value", () => {
    expect(changedProperties({ a: 1, b: ["x"], c: "same" }, { a: 2, b: ["x"], c: "same", d: true }).sort()).toEqual(["a", "d"]);
    expect(changedProperties({ a: 1 }, {})).toEqual(["a"]);
    expect(changedProperties({ a: null }, {})).toEqual([]);
  });
});

describe("matchesTrigger", () => {
  it("row_created matches new rows only", () => {
    expect(matchesTrigger({ type: "row_created" }, create({}))).toBe(true);
    expect(matchesTrigger({ type: "row_created" }, update({}, { a: 1 }))).toBe(false);
  });

  it("any property matches a change, not a new row or a save of the same values", () => {
    const any = { type: "property_changed", propertyId: null } as const;
    expect(matchesTrigger(any, update({ a: 1 }, { a: 2 }))).toBe(true);
    expect(matchesTrigger(any, update({ a: 1 }, { a: 1 }))).toBe(false);
    expect(matchesTrigger(any, create({ a: 1 }))).toBe(false);
  });

  it("one property matches when it changes, whatever to, not on a new row", () => {
    const t = { type: "property_changed", propertyId: "a" } as const;
    expect(matchesTrigger(t, update({ a: 1, b: 1 }, { a: 2, b: 1 }))).toBe(true);
    expect(matchesTrigger(t, update({ a: 1, b: 1 }, { a: 1, b: 2 }))).toBe(false);
    expect(matchesTrigger(t, create({ a: 1 }))).toBe(false);
    expect(matchesTrigger(t, create({}))).toBe(false);
  });

  it("select and status: only when the value becomes the option", () => {
    const t = { type: "property_changed", propertyId: "s", to: "done" } as const;
    expect(matchesTrigger(t, update({ s: "doing" }, { s: "done" }))).toBe(true);
    expect(matchesTrigger(t, update({ s: "done" }, { s: "done", x: 1 }))).toBe(false);
    expect(matchesTrigger(t, update({ s: "done" }, { s: "doing" }))).toBe(false);
    expect(matchesTrigger(t, update({}, { s: "doing" }))).toBe(false);
    expect(matchesTrigger(t, create({ s: "done" }))).toBe(true);
  });

  it("checkbox: unset counts as unchecked", () => {
    const on = { type: "property_changed", propertyId: "c", to: true } as const;
    const off = { type: "property_changed", propertyId: "c", to: false } as const;
    expect(matchesTrigger(on, update({}, { c: true }))).toBe(true);
    expect(matchesTrigger(off, update({ c: true }, { c: false }))).toBe(true);
    expect(matchesTrigger(off, update({ c: true }, {}))).toBe(true);
    expect(matchesTrigger(off, update({}, { c: false }))).toBe(false);
  });

  it("person and multi-select: when the id gets added", () => {
    const t = { type: "property_changed", propertyId: "p", to: "u1" } as const;
    expect(matchesTrigger(t, update({ p: ["u2"] }, { p: ["u2", "u1"] }))).toBe(true);
    expect(matchesTrigger(t, update({ p: ["u1"] }, { p: ["u1", "u2"] }))).toBe(false);
    expect(matchesTrigger(t, update({ p: ["u1"] }, { p: [] }))).toBe(false);
  });
});

describe("isDynamicValue", () => {
  it("knows now and actor, and nothing else", () => {
    expect(isDynamicValue({ $: "now" })).toBe(true);
    expect(isDynamicValue({ $: "actor" })).toBe(true);
    expect(isDynamicValue({ $: "now", x: 1 })).toBe(false);
    expect(isDynamicValue({ $: "later" })).toBe(false);
    expect(isDynamicValue("now")).toBe(false);
    expect(isDynamicValue(null)).toBe(false);
    expect(isDynamicValue([{ $: "now" }])).toBe(false);
  });
});

describe("retries", () => {
  it("backs off and stops growing", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(4)).toBe(7_200_000);
    expect(retryDelayMs(9)).toBe(7_200_000);
  });

  it("retries network errors, 408, 429 and 5xx only", () => {
    expect(retriable(null)).toBe(true);
    expect(retriable(500)).toBe(true);
    expect(retriable(503)).toBe(true);
    expect(retriable(429)).toBe(true);
    expect(retriable(408)).toBe(true);
    expect(retriable(400)).toBe(false);
    expect(retriable(404)).toBe(false);
  });
});

describe("runStatusOf", () => {
  const step = (status: AutomationStep["status"]): AutomationStep => ({ type: "webhook", status, attempts: 1 });
  it("waits while a step waits, fails when one failed, else is done", () => {
    expect(runStatusOf([step("done"), step("pending")])).toBe("pending");
    expect(runStatusOf([step("done"), step("failed")])).toBe("failed");
    expect(runStatusOf([step("done"), step("skipped")])).toBe("done");
    expect(runStatusOf([])).toBe("done");
  });
});

describe("signature format", () => {
  it("signs the timestamp and the body", () => {
    expect(signedContent(1700000000, '{"a":1}')).toBe('1700000000.{"a":1}');
    expect(signatureHeader(1700000000, "abc")).toBe("t=1700000000,v1=abc");
  });
});

describe("date passed", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");

  it("is never started by a write", () => {
    const t = { type: "date_passed", date: "last_edited_time", days: 0 } as const;
    expect(matchesTrigger(t, create({ a: 1 }))).toBe(false);
    expect(matchesTrigger(t, update({ a: 1 }, { a: 2 }))).toBe(false);
  });

  it("counts days by the calendar and times by the clock", () => {
    expect(datePassedCutoffs(0, now, "2026-10-11")).toEqual({ day: "2026-10-11", instant: "2026-10-11T12:00:00.000Z" });
    expect(datePassedCutoffs(14, now, "2026-10-11")).toEqual({ day: "2026-09-27", instant: "2026-09-27T12:00:00.000Z" });
    // Across a month and a year.
    expect(datePassedCutoffs(30, new Date("2026-01-15T00:00:00Z"), "2026-01-15").day).toBe("2025-12-16");
  });

  it("takes the start of a date value, of either kind", () => {
    expect(dateStart("2026-10-01")).toBe("2026-10-01");
    expect(dateStart("2026-10-01/2026-10-05")).toBe("2026-10-01");
    expect(dateStart("2026-10-01T09:30:00.000Z/2026-10-01T10:00:00.000Z")).toBe("2026-10-01T09:30:00.000Z");
    expect(dateStart("")).toBeNull();
    expect(dateStart(null)).toBeNull();
    expect(dateStart("soon")).toBeNull();
  });

  it("a date is past on its day (0 days), a time once it has come", () => {
    const today = datePassedCutoffs(0, now, "2026-10-11");
    expect(startPassed("2026-10-11", today)).toBe(true);
    expect(startPassed("2026-10-12", today)).toBe(false);
    expect(startPassed("2026-10-11T11:59:00.000Z", today)).toBe(true);
    expect(startPassed("2026-10-11T12:01:00.000Z", today)).toBe(false);
    const twoWeeks = datePassedCutoffs(14, now, "2026-10-11");
    expect(startPassed("2026-09-27", twoWeeks)).toBe(true);
    expect(startPassed("2026-09-28", twoWeeks)).toBe(false);
  });

  it("matches status groups, a row without a (known) status counting as to do", () => {
    const options = [
      { id: "a", group: "todo" as const },
      { id: "b", group: "in_progress" as const },
      { id: "c", group: "done" as const },
      { id: "d" },
    ];
    const notDone = statusMatch(options, ["todo", "in_progress"]);
    expect(notDone.optionIds).toEqual(["a", "b", "d"]);
    expect(statusMeets("a", notDone)).toBe(true);
    expect(statusMeets("c", notDone)).toBe(false);
    expect(statusMeets(undefined, notDone)).toBe(true);
    expect(statusMeets("gone", notDone)).toBe(true);
    const done = statusMatch(options, ["done"]);
    expect(statusMeets("c", done)).toBe(true);
    expect(statusMeets(undefined, done)).toBe(false);
    expect(statusMeets("a", done)).toBe(false);
  });

  it("fires once per value of the date, again for a new value that is past too", () => {
    const cutoffs = datePassedCutoffs(30, now, "2026-10-11");
    const trigger = { status: null };
    const old = { basis: "2026-08-01T10:00:00.000000Z" };
    expect(datePassedFires(old, trigger, cutoffs, null, null)).toBe(true);
    // Fired for this value already: a restored row, or a check that runs again.
    expect(datePassedFires(old, trigger, cutoffs, null, old.basis)).toBe(false);
    // Edited since, and stale again.
    expect(datePassedFires({ basis: "2026-09-01T10:00:00.000000Z" }, trigger, cutoffs, null, old.basis)).toBe(true);
    // Edited since, not stale yet.
    expect(datePassedFires({ basis: "2026-10-01T10:00:00.000000Z" }, trigger, cutoffs, null, old.basis)).toBe(false);
    // No date, nothing to count from.
    expect(datePassedFires({ basis: null }, trigger, cutoffs, null, null)).toBe(false);
  });

  it("a row that stops meeting the status condition stops firing", () => {
    const cutoffs = datePassedCutoffs(14, now, "2026-10-11");
    const match = statusMatch([{ id: "open", group: "todo" }, { id: "closed", group: "done" }], ["done"]);
    const trigger = { status: { propertyId: "s", groups: ["done" as const] } };
    expect(datePassedFires({ basis: "2026-09-01", status: "closed" }, trigger, cutoffs, match, null)).toBe(true);
    expect(datePassedFires({ basis: "2026-09-01", status: "open" }, trigger, cutoffs, match, null)).toBe(false);
  });

  it("is checked every ten minutes unless set otherwise, never more often than every 10 seconds", () => {
    expect(dateCheckIntervalMs(undefined)).toBe(600_000);
    expect(dateCheckIntervalMs("")).toBe(600_000);
    expect(dateCheckIntervalMs("soon")).toBe(600_000);
    expect(dateCheckIntervalMs("-5")).toBe(600_000);
    expect(dateCheckIntervalMs("60")).toBe(60_000);
    expect(dateCheckIntervalMs("1")).toBe(10_000);
  });

  it("names a date-passed run's event apart", () => {
    expect(runEvent({ created: false, basis: "2026-10-01" })).toBe("row.date_passed");
    expect(runEvent({ created: true, basis: null })).toBe("row.created");
    expect(runEvent({ created: false, basis: null })).toBe("row.updated");
  });
});

describe("trashProblem", () => {
  const of = (...types: string[]) => types.map((type) => ({ type }) as { type: "notify" });
  it("lets moving to the trash come last only, once, and not with an agent", () => {
    expect(trashProblem(of("notify", "webhook"))).toBeNull();
    expect(trashProblem(of("notify", "move_to_trash"))).toBeNull();
    expect(trashProblem(of("move_to_trash"))).toBeNull();
    expect(trashProblem(of("move_to_trash", "notify"))).toBe("trashNotLast");
    expect(trashProblem(of("move_to_trash", "move_to_trash"))).toBe("trashNotLast");
    expect(trashProblem(of("run_agent", "move_to_trash"))).toBe("trashWithAgent");
  });
});
