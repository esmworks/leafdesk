import { describe, expect, it } from "vitest";
import { hasAgentLevel, isAgentShareLevel, resolveAgentLevel } from "./agent-sharing";

describe("resolveAgentLevel", () => {
  it("gives workspace owners full access, listed or not", () => {
    expect(resolveAgentLevel({ role: "owner" })).toBe("full");
    expect(resolveAgentLevel({ role: "owner", person: "interact", everyone: "interact" })).toBe("full");
  });

  it("gives guests and people outside the workspace nothing, whatever the list says", () => {
    expect(resolveAgentLevel({ role: "guest", person: "full", groups: ["full"], everyone: "full" })).toBe("none");
    expect(resolveAgentLevel({ role: null, everyone: "interact" })).toBe("none");
  });

  it("lets a person's own entry decide, even when it is lower than their group's or everyone's", () => {
    expect(resolveAgentLevel({ role: "member", person: "interact", groups: ["full"], everyone: "edit" })).toBe("interact");
    expect(resolveAgentLevel({ role: "member", person: "full", groups: ["interact"], everyone: "interact" })).toBe("full");
  });

  it("takes the highest of their groups' entries before everyone's", () => {
    expect(resolveAgentLevel({ role: "member", groups: ["interact", "edit"], everyone: "full" })).toBe("edit");
    expect(resolveAgentLevel({ role: "member", groups: ["edit", "full", "interact"] })).toBe("full");
  });

  it("falls back to everyone's entry, and to no access without one", () => {
    expect(resolveAgentLevel({ role: "member", everyone: "interact" })).toBe("interact");
    expect(resolveAgentLevel({ role: "member", groups: [] })).toBe("none");
  });
});

describe("levels", () => {
  it("orders interact < edit < full", () => {
    expect(hasAgentLevel("full", "edit")).toBe(true);
    expect(hasAgentLevel("edit", "edit")).toBe(true);
    expect(hasAgentLevel("interact", "edit")).toBe(false);
    expect(hasAgentLevel("none", "interact")).toBe(false);
  });

  it("knows the levels an agent is shared at", () => {
    expect(isAgentShareLevel("interact")).toBe(true);
    expect(isAgentShareLevel("view")).toBe(false);
    expect(isAgentShareLevel("none")).toBe(false);
  });
});
