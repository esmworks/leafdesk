import { describe, expect, it } from "vitest";
import { isAgentHelpersMode, MAX_REPORTING_DEPTH, reportingProblem, routeTo } from "./agent-team";

describe("isAgentHelpersMode", () => {
  it("takes the three modes only", () => {
    expect(["none", "chosen", "all"].every(isAgentHelpersMode)).toBe(true);
    expect(isAgentHelpersMode("some")).toBe(false);
    expect(isAgentHelpersMode(null)).toBe(false);
  });
});

describe("reportingProblem", () => {
  const chain = (pairs: [string, string | null][]) => new Map(pairs);

  it("refuses an agent reporting to itself", () => {
    expect(reportingProblem("a", "a", chain([]))).toBe("self");
  });

  it("refuses a loop, however long", () => {
    // b reports to a: a can't report to b.
    expect(reportingProblem("a", "b", chain([["b", "a"]]))).toBe("loop");
    // c → b → a: a can't report to c.
    expect(reportingProblem("a", "c", chain([["c", "b"], ["b", "a"]]))).toBe("loop");
  });

  it("allows a tree", () => {
    expect(reportingProblem("a", "m", chain([["b", "m"], ["m", null]]))).toBeNull();
    expect(reportingProblem("a", "m", chain([["m", "boss"], ["boss", null]]))).toBeNull();
  });

  it("keeps chains to MAX_REPORTING_DEPTH, counting those under the agent", () => {
    const ids = Array.from({ length: MAX_REPORTING_DEPTH + 1 }, (_, i) => `m${i}`);
    // m1 → m0, m2 → m1 …: a chain of MAX_REPORTING_DEPTH + 1 agents.
    const pairs: [string, string | null][] = ids.map((id, i) => [id, i ? ids[i - 1] : null]);
    const reports = chain(pairs);
    // Under m(i), x is i + 1 links from the top.
    expect(reportingProblem("x", ids[MAX_REPORTING_DEPTH], reports)).toBe("tooDeep");
    expect(reportingProblem("x", ids[MAX_REPORTING_DEPTH - 1], reports)).toBeNull();
    // An agent with one below it fits one level less high.
    const withChild = chain([...pairs, ["child", "x"]]);
    expect(reportingProblem("x", ids[MAX_REPORTING_DEPTH - 1], withChild)).toBe("tooDeep");
    expect(reportingProblem("x", ids[MAX_REPORTING_DEPTH - 2], withChild)).toBeNull();
  });
});

describe("routeTo", () => {
  const member = { id: "a", reportsTo: "m", viaManagerOnly: true };

  it("leaves agents that don't work through a manager alone", () => {
    expect(routeTo({ ...member, viaManagerOnly: false }, false, () => true)).toBe("a");
    expect(routeTo({ ...member, reportsTo: null }, false, () => true)).toBe("a");
  });

  it("sends people who can't edit the agent to its manager", () => {
    expect(routeTo(member, false, () => true)).toBe("m");
  });

  it("lets those who edit the agent reach it", () => {
    expect(routeTo(member, true, () => false)).toBe("a");
  });

  it("goes nowhere when the manager is out of reach", () => {
    expect(routeTo(member, false, () => false)).toBeNull();
  });
});
