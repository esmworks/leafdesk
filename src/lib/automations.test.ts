import { describe, expect, it } from "vitest";
import {
  changedProperties,
  isDynamicValue,
  matchesTrigger,
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
