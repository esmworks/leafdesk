import { describe, expect, it } from "vitest";
import {
  addGroup,
  arrangeAgents,
  cleanAgentArrangement,
  foldGroup,
  MAX_AGENT_GROUPS,
  moveAgent,
  moveGroup,
  removeGroup,
  renameGroup,
  settled,
  sortByName,
  type AgentArrangement,
} from "./agent-arrangement";

const agents = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((a) => a.id);
const two: AgentArrangement = { groups: [{ id: "g1", name: "Sales", agents: ["c", "a"] }, { id: "g2", name: "Mail", agents: [] }], loose: ["d"] };

describe("arrangeAgents", () => {
  it("lists every agent in no group, in their order, without an arrangement", () => {
    const { groups, loose } = arrangeAgents(agents, undefined);
    expect(groups).toEqual([]);
    expect(ids(loose)).toEqual(["a", "b", "c", "d"]);
  });

  it("follows the groups and puts agents it doesn't place last", () => {
    const { groups, loose } = arrangeAgents(agents, two);
    expect(groups.map((g) => [g.group.id, ids(g.agents)])).toEqual([
      ["g1", ["c", "a"]],
      ["g2", []],
    ]);
    expect(ids(loose)).toEqual(["d", "b"]);
  });

  it("skips agents no longer shown and shows each agent once", () => {
    const { groups, loose } = arrangeAgents([{ id: "a" }], { groups: [{ id: "g", name: "G", agents: ["x", "a"] }], loose: ["a"] });
    expect(ids(groups[0].agents)).toEqual(["a"]);
    expect(loose).toEqual([]);
  });

  it("writes out only the agents shown, each placed", () => {
    expect(settled([{ id: "a" }, { id: "b" }], two)).toEqual({ groups: [{ id: "g1", name: "Sales", agents: ["a"] }, { id: "g2", name: "Mail", agents: [] }], loose: ["b"] });
  });
});

describe("moveAgent", () => {
  it("moves an agent into a group at a place", () => {
    expect(moveAgent(two, "d", { group: "g1", index: 1 })).toEqual({ ...two, groups: [{ ...two.groups[0], agents: ["c", "d", "a"] }, two.groups[1]], loose: [] });
  });

  it("counts the index in the list as shown when moving within it", () => {
    expect(moveAgent(two, "c", { group: "g1", index: 2 }).groups[0].agents).toEqual(["a", "c"]);
    expect(moveAgent(two, "a", { group: "g1", index: 0 }).groups[0].agents).toEqual(["a", "c"]);
  });

  it("moves an agent out of every group", () => {
    const moved = moveAgent(two, "c", { group: null, index: 0 });
    expect(moved.groups[0].agents).toEqual(["a"]);
    expect(moved.loose).toEqual(["c", "d"]);
  });

  it("leaves the arrangement as it is for a group that isn't there", () => {
    expect(moveAgent(two, "d", { group: "gone", index: 0 })).toBe(two);
  });
});

describe("groups", () => {
  it("adds a group last, with the agent given in it", () => {
    const added = addGroup(two, "g3", "  Ops  ", "d");
    expect(added.groups.at(-1)).toEqual({ id: "g3", name: "Ops", agents: ["d"] });
    expect(added.loose).toEqual([]);
    expect(addGroup(two, "g3", "   ")).toBe(two);
  });

  it("stops adding groups at the limit", () => {
    const full: AgentArrangement = { groups: Array.from({ length: MAX_AGENT_GROUPS }, (_, i) => ({ id: `g${i}`, name: "G", agents: [] })), loose: [] };
    expect(addGroup(full, "one-more", "More")).toBe(full);
  });

  it("renames, folds and moves groups", () => {
    expect(renameGroup(two, "g2", "Inbox").groups[1].name).toBe("Inbox");
    expect(renameGroup(two, "g2", " ")).toBe(two);
    expect(foldGroup(two, "g1", true).groups[0].folded).toBe(true);
    expect(foldGroup(foldGroup(two, "g1", true), "g1", false).groups[0]).not.toHaveProperty("folded");
    expect(moveGroup(two, "g2", 0).groups.map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(moveGroup(two, "g1", 2).groups.map((g) => g.id)).toEqual(["g2", "g1"]);
  });

  it("puts a removed group's agents at the top of those in no group", () => {
    expect(removeGroup(two, "g1")).toEqual({ groups: [two.groups[1]], loose: ["c", "a", "d"] });
  });

  it("sorts by name inside each group", () => {
    const names = new Map([
      ["a", "Zed"],
      ["c", "agent 10"],
      ["d", "Agent 9"],
    ]);
    expect(sortByName({ groups: [{ id: "g", name: "G", agents: ["a", "c", "d"] }], loose: [] }, names, "en").groups[0].agents).toEqual(["d", "c", "a"]);
  });
});

describe("cleanAgentArrangement", () => {
  it("keeps each agent once and drops what isn't a group", () => {
    expect(
      cleanAgentArrangement({
        groups: [{ id: "g", name: " Sales ", agents: ["a", "a", 3], folded: true, extra: 1 }, { id: "g", name: "Twice", agents: [] }, { id: "h", name: "", agents: [] }, "nope"],
        loose: ["a", "b"],
      }),
    ).toEqual({ groups: [{ id: "g", name: "Sales", agents: ["a"], folded: true }], loose: ["b"] });
  });

  it("rejects what isn't an arrangement", () => {
    expect(cleanAgentArrangement(null)).toBeNull();
    expect(cleanAgentArrangement({ groups: [] })).toBeNull();
    expect(cleanAgentArrangement([])).toBeNull();
  });

  it("cuts long names", () => {
    expect(cleanAgentArrangement({ groups: [{ id: "g", name: "x".repeat(100), agents: [] }], loose: [] })?.groups[0].name).toHaveLength(60);
  });
});
