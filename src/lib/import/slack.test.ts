import { describe, expect, it } from "vitest";
import { compareTs, readSlackExport, slackBody, slackEmoji, type SlackNames } from "./slack";
import { SLACK_TS, slackFixtureFiles } from "./slack-fixtures";

const names: SlackNames = {
  user: (id) => (id === "U1" ? { userId: "user-ayse", name: "Ayşe" } : { userId: null, name: id === "U3" ? "Cem" : "someone" }),
  channel: (id) => (id === "C2" ? "old-project-2" : null),
};

describe("readSlackExport", () => {
  const read = readSlackExport(slackFixtureFiles());

  it("reads users with their emails, lowercased", () => {
    expect(read.users.get("U1")).toEqual({ id: "U1", name: "ayse", email: "ayse@example.com", bot: false });
    expect(read.users.get("U2")).toMatchObject({ name: "Bora Demir", email: "bora@example.com" });
    expect(read.users.get("U3")?.email).toBeNull();
    expect(read.users.get("B1")?.bot).toBe(true);
  });

  it("reads public and private channels, not direct conversations", () => {
    expect(read.channels.map((c) => [c.name, c.kind, c.archived])).toEqual([
      ["general", "public", false],
      ["old-project", "public", true],
      ["secret-plans", "private", false],
    ]);
    expect(read.directConversations).toBe(1);
    const general = read.channels[0];
    expect(general).toMatchObject({ topic: "Company-wide", purpose: "Everything &amp; anything", creator: "U1", members: ["U1", "U2", "U3"], created: 1_699_999_000_000 });
  });

  it("orders messages by ts across days, without events or repeats", () => {
    const general = read.channels[0];
    const order = general.messages.map((m) => m.ts);
    expect(order).toEqual([...order].sort(compareTs));
    expect(order.filter((ts) => ts === SLACK_TS.reply2)).toHaveLength(1);
    expect(general.messages.some((m) => m.text.includes("has joined"))).toBe(false);
    // Two messages in the same millisecond keep their order.
    expect(order.indexOf(SLACK_TS.broadcast)).toBeLessThan(order.indexOf(SLACK_TS.tie));
    expect(general.messages.find((m) => m.ts === SLACK_TS.tie)).toMatchObject({ text: "Deployed v1.2", name: "Deploy Bot", user: null });
  });

  it("links replies to their thread and makes orphans messages of their own", () => {
    const general = read.channels[0];
    const byTs = new Map(general.messages.map((m) => [m.ts, m]));
    expect(byTs.get(SLACK_TS.thread)?.threadTs).toBeNull();
    expect(byTs.get(SLACK_TS.reply1)?.threadTs).toBe(SLACK_TS.thread);
    expect(byTs.get(SLACK_TS.broadcast)).toMatchObject({ threadTs: SLACK_TS.thread, broadcast: true });
    expect(byTs.get(SLACK_TS.tombstone)).toMatchObject({ deleted: true, text: "" });
    expect(byTs.get(SLACK_TS.orphan)?.threadTs).toBeNull();
    expect(read.repliesWithoutThread).toBe(1);
    expect(byTs.get(SLACK_TS.thread)?.edited).toBe(1_700_000_090_000);
  });

  it("reads reactions and files, leaving out hidden ones", () => {
    const general = read.channels[0];
    expect(general.messages[0].reactions).toEqual([
      { name: "heart", users: ["U2", "U3"] },
      { name: "partyparrot", users: ["U2"] },
    ]);
    const shared = general.messages.find((m) => m.files.length);
    expect(shared?.files).toEqual([
      {
        name: "spec.pdf",
        download: "https://files.slack.com/files-pri/T1-F1/download/spec.pdf?t=xoxe-secret",
        permalink: "https://team.slack.com/files/U2/F1/spec.pdf",
        contentType: "application/pdf",
        size: 1234,
      },
    ]);
  });

  it("refuses an upload that isn't an export", () => {
    expect(() => readSlackExport(new Map([["notes.json", new TextEncoder().encode("[]")]]))).toThrow(expect.objectContaining({ code: "badSlack" }));
  });

  it("survives broken day files", () => {
    const files = slackFixtureFiles();
    files.set("Slack export/general/2023-11-15.json", new TextEncoder().encode("{not json"));
    expect(readSlackExport(files).channels[0].messages.length).toBeGreaterThan(0);
  });
});

describe("slackEmoji", () => {
  it("knows Slack's names and skin tones", () => {
    expect(slackEmoji("thumbsup")).toBe("👍️");
    expect(slackEmoji("+1")).toBe("👍️");
    expect(slackEmoji("+1::skin-tone-3")).toBe("👍🏼");
    expect(slackEmoji("white_check_mark")).toBe("✅️");
    expect(slackEmoji("partyparrot")).toBeNull();
  });
});

describe("slackBody", () => {
  it("turns people, channels, links, entities and marks into Markdown", () => {
    expect(slackBody("Hello *team* &amp; welcome to <#C2|old-project>! :wave: :+1::skin-tone-3:", names)).toBe("Hello **team** & welcome to #old-project-2! 👋 👍🏼");
    expect(slackBody("Plan for <@U1>: see <https://example.com/plan|the plan>", names)).toBe("Plan for [@Ayşe](leafdesk:user/user-ayse): see [the plan](https://example.com/plan)");
    expect(slackBody("ask <@U3> or <@U9|old name>", names)).toBe("ask @Cem or @old name");
    expect(slackBody("Looks good ~mostly~", names)).toBe("Looks good ~~mostly~~");
  });

  it("keeps broadcasts as words", () => {
    expect(slackBody("Shipping it <!channel> <!here|here>", names)).toBe("Shipping it @channel @here");
    expect(slackBody("<!subteam^S1|@design> please", names)).toBe("@design please");
  });

  it("leaves code alone but for tokens and entities", () => {
    expect(slackBody("run `a *b* <@U1>` now", names)).toBe("run `a *b* @Ayşe` now");
    expect(slackBody("```if (a &lt; b) *x*```", names)).toBe("```\nif (a < b) *x*\n```");
  });

  it("writes plain links and mail addresses", () => {
    expect(slackBody("<https://example.com>", names)).toBe("<https://example.com>");
    expect(slackBody("<mailto:a@example.com|a@example.com>", names)).toBe("[a@example.com](mailto:a@example.com)");
    expect(slackBody("<javascript:alert(1)|click>", names)).toBe("click");
  });

  it("leaves lone marks and stray brackets as written", () => {
    expect(slackBody("2 * 3 * 4 and a*b*c and <not closed", names)).toBe("2 * 3 * 4 and a*b*c and <not closed");
    expect(slackBody("time 10:30:45 and :not_an_emoji_here:", names)).toBe("time 10:30:45 and :not_an_emoji_here:");
  });

  it("stays fast on hostile text", () => {
    const start = performance.now();
    slackBody(`${"*a ".repeat(15_000)}${"<".repeat(40_000)}${"< a\n".repeat(10_000)}${":x".repeat(5000)}${"`".repeat(5000)}`, names);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
