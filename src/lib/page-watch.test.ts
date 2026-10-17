import { describe, expect, it } from "vitest";
import {
  PAGE_EMAIL_COOLDOWN_MS,
  PAGE_EMAIL_DAILY_CAP,
  PAGE_EMAIL_WINDOW_MS,
  PAGE_UPDATE_IDLE_MS,
  PAGE_UPDATE_MAX_WAIT_MS,
  pageUpdateAudience,
  pageUpdateDueAt,
  pageWatchers,
  planPageEmails,
} from "./page-watch";

const HOUR = 3_600_000;
const now = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("pageWatchers", () => {
  it("counts the creator, teamspace watchers and those who chose to watch", () => {
    const watchers = pageWatchers({
      createdBy: "ada",
      teamspaceWatchers: ["grace"],
      chosen: [{ userId: "linus", watching: true }],
    });
    expect(watchers.sort()).toEqual(["ada", "grace", "linus"]);
  });

  it("lets a mute win over being the creator, an editor or a teamspace watcher", () => {
    const watchers = pageWatchers({
      createdBy: "ada",
      teamspaceWatchers: ["grace", "ada"],
      chosen: [
        { userId: "ada", watching: false },
        { userId: "grace", watching: false },
        { userId: "linus", watching: true },
      ],
    });
    expect(watchers).toEqual(["linus"]);
  });

  it("has no creator for pages whose creator left", () => {
    expect(pageWatchers({ createdBy: null, chosen: [] })).toEqual([]);
  });
});

describe("pageUpdateAudience", () => {
  it("leaves out the author and people who have the page open", () => {
    expect(pageUpdateAudience(["ada", "grace", "linus", "ada"], "ada", new Set(["linus"]))).toEqual(["grace"]);
  });

  it("tells everyone watching when nobody is named as the author", () => {
    expect(pageUpdateAudience(["ada", "grace"], null, [])).toEqual(["ada", "grace"]);
  });
});

describe("pageUpdateDueAt", () => {
  it("waits for a pause in writing, but not forever", () => {
    const first = ago(0);
    expect(pageUpdateDueAt(first, now).getTime()).toBe(now.getTime() + PAGE_UPDATE_IDLE_MS);
    const later = new Date(first.getTime() + PAGE_UPDATE_MAX_WAIT_MS - 1000);
    expect(pageUpdateDueAt(first, later).getTime()).toBe(first.getTime() + PAGE_UPDATE_MAX_WAIT_MS);
  });
});

describe("planPageEmails", () => {
  it("emails each page on its own while under the daily cap", () => {
    const plan = planPageEmails({
      now,
      due: [
        { id: "n1", pageId: "p1" },
        { id: "n2", pageId: "p2" },
      ],
      lastSentByPage: new Map(),
      sentInWindow: [ago(2 * HOUR)],
    });
    expect(plan).toEqual({ single: ["n1", "n2"], digest: [], later: [] });
  });

  it("holds a page emailed about within the cooldown until it ends", () => {
    const plan = planPageEmails({
      now,
      due: [
        { id: "n1", pageId: "p1" },
        { id: "n2", pageId: "p2" },
      ],
      lastSentByPage: new Map([
        ["p1", ago(HOUR)],
        ["p2", ago(PAGE_EMAIL_COOLDOWN_MS + 1)],
      ]),
      sentInWindow: [ago(HOUR)],
    });
    expect(plan.single).toEqual(["n2"]);
    expect(plan.later).toEqual([{ id: "n1", until: new Date(ago(HOUR).getTime() + PAGE_EMAIL_COOLDOWN_MS) }]);
  });

  it("holds everything until the oldest email turns a day old once the cap is used up", () => {
    const sent = Array.from({ length: PAGE_EMAIL_DAILY_CAP }, (_, i) => ago((i + 1) * HOUR));
    const plan = planPageEmails({ now, due: [{ id: "n1", pageId: "p1" }], lastSentByPage: new Map(), sentInWindow: sent });
    expect(plan.single).toEqual([]);
    expect(plan.digest).toEqual([]);
    expect(plan.later).toEqual([{ id: "n1", until: new Date(ago(PAGE_EMAIL_DAILY_CAP * HOUR).getTime() + PAGE_EMAIL_WINDOW_MS) }]);
  });

  it("sends one digest when more pages wait than the cap has room for", () => {
    const sent = Array.from({ length: PAGE_EMAIL_DAILY_CAP - 1 }, (_, i) => ago((i + 1) * HOUR));
    const plan = planPageEmails({
      now,
      due: [
        { id: "n1", pageId: "p1" },
        { id: "n2", pageId: "p2" },
      ],
      lastSentByPage: new Map(),
      sentInWindow: sent,
    });
    expect(plan).toEqual({ single: [], digest: ["n1", "n2"], later: [] });
  });

  it("forgets emails older than a day", () => {
    const sent = Array.from({ length: PAGE_EMAIL_DAILY_CAP }, () => ago(PAGE_EMAIL_WINDOW_MS + HOUR));
    const plan = planPageEmails({ now, due: [{ id: "n1", pageId: "p1" }], lastSentByPage: new Map(), sentInWindow: sent });
    expect(plan.single).toEqual(["n1"]);
  });

  it("does nothing with nothing due", () => {
    expect(planPageEmails({ now, due: [], lastSentByPage: new Map(), sentInWindow: [] })).toEqual({ single: [], digest: [], later: [] });
  });
});
