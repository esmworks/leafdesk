import { describe, expect, it } from "vitest";
import {
  ACCESS_REQUEST_MESSAGE_MAX,
  approvalLevelsFor,
  cleanRequestMessage,
  isApprovalLevel,
  isMoreAccessLevel,
  initialApprovalLevel,
  levelsToAsk,
  requestedPageId,
} from "./access-requests";

describe("cleanRequestMessage", () => {
  it("keeps the text, trimmed", () => {
    expect(cleanRequestMessage("  I need this for the launch  ")).toBe("I need this for the launch");
  });

  it("drops empty messages and anything that isn't text", () => {
    expect(cleanRequestMessage("")).toBeNull();
    expect(cleanRequestMessage(" \n\t ")).toBeNull();
    expect(cleanRequestMessage(undefined)).toBeNull();
    expect(cleanRequestMessage(42)).toBeNull();
    expect(cleanRequestMessage({ toString: () => "x" })).toBeNull();
  });

  it("keeps line breaks but not other control characters", () => {
    expect(cleanRequestMessage("one\r\ntwo\rthree\u0000\u0007\u001b[31m")).toBe("one\ntwo\nthree[31m");
    expect(cleanRequestMessage("tab\there")).toBe("tab here");
  });

  it("cuts long messages by characters, not code units", () => {
    const long = "é".repeat(ACCESS_REQUEST_MESSAGE_MAX + 20);
    expect(cleanRequestMessage(long)).toHaveLength(ACCESS_REQUEST_MESSAGE_MAX);
    const emoji = "👋".repeat(ACCESS_REQUEST_MESSAGE_MAX + 1);
    const cut = cleanRequestMessage(emoji)!;
    expect([...cut]).toHaveLength(ACCESS_REQUEST_MESSAGE_MAX);
    expect(cut.endsWith("👋")).toBe(true);
  });
});

describe("isApprovalLevel", () => {
  it("accepts the levels a request can be approved at", () => {
    for (const level of ["view", "comment", "edit", "full"]) expect(isApprovalLevel(level)).toBe(true);
  });

  it("refuses no access and anything else", () => {
    for (const level of ["none", "owner", "", null, undefined, 3, "toString"]) expect(isApprovalLevel(level)).toBe(false);
  });
});

describe("requestedPageId", () => {
  it("finds the page of a page path in the workspace", () => {
    expect(requestedPageId("/w/ws-1/p/page-1", "ws-1")).toBe("page-1");
    expect(requestedPageId("/w/ws-1/p/page-1?view=table", "ws-1")).toBe("page-1");
    expect(requestedPageId("/w/ws-1/p/page-1/", "ws-1")).toBe("page-1");
    expect(requestedPageId("/w/ws%201/p/page%2D1", "ws 1")).toBe("page-1");
  });

  it("ignores everything else under the workspace", () => {
    expect(requestedPageId("/w/ws-1", "ws-1")).toBeNull();
    expect(requestedPageId("/w/ws-1/settings", "ws-1")).toBeNull();
    expect(requestedPageId("/w/ws-1/settings?tab=security", "ws-1")).toBeNull();
    expect(requestedPageId("/w/ws-1/p/page-1/export", "ws-1")).toBeNull();
    expect(requestedPageId("/w/ws-1/p/", "ws-1")).toBeNull();
  });

  it("only for the workspace being rendered", () => {
    expect(requestedPageId("/w/ws-2/p/page-1", "ws-1")).toBeNull();
    expect(requestedPageId("/x/w/ws-1/p/page-1", "ws-1")).toBeNull();
  });

  it("without a path, or with a broken one", () => {
    expect(requestedPageId(null, "ws-1")).toBeNull();
    expect(requestedPageId(undefined, "ws-1")).toBeNull();
    expect(requestedPageId("/w/ws-1/p/%E0%A4%A", "ws-1")).toBeNull();
  });
});

describe("asking for more access", () => {
  it("offers what is above the current level, up to edit", () => {
    expect(levelsToAsk("view")).toEqual(["comment", "edit"]);
    expect(levelsToAsk("comment")).toEqual(["edit"]);
    expect(levelsToAsk("edit")).toEqual([]);
    expect(levelsToAsk("full")).toEqual([]);
    // Without access, people ask from the "You don't have access" screen instead.
    expect(levelsToAsk("none")).toEqual([]);
  });

  it("takes only comment and edit", () => {
    expect(isMoreAccessLevel("edit")).toBe(true);
    expect(isMoreAccessLevel("comment")).toBe(true);
    expect(isMoreAccessLevel("view")).toBe(false);
    expect(isMoreAccessLevel("full")).toBe(false);
    expect(isMoreAccessLevel(3)).toBe(false);
  });

  it("lets approvers give only more than the requester has", () => {
    expect(approvalLevelsFor("none")).toEqual(["view", "comment", "content", "edit", "full"]);
    expect(approvalLevelsFor("view")).toEqual(["comment", "content", "edit", "full"]);
    expect(approvalLevelsFor("comment")).toEqual(["content", "edit", "full"]);
    expect(approvalLevelsFor("content")).toEqual(["edit", "full"]);
    expect(approvalLevelsFor("full")).toEqual([]);
  });

  it("starts the approver's picker at the level asked for", () => {
    expect(initialApprovalLevel({ level: "comment", current: "view" }, "edit")).toBe("comment");
    expect(initialApprovalLevel({ level: "view", current: "none" }, "edit")).toBe("edit");
    expect(initialApprovalLevel({ level: "view", current: "none" }, "full")).toBe("full");
  });
});
