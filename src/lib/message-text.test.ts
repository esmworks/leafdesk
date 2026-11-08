import { describe, expect, it } from "vitest";
import { withoutCalls } from "./message-quiet";
import { broadcastOf, linkedPageIds, mentionedUserIds } from "./message-text";

describe("withoutCalls", () => {
  it("turns mentions of people and @here / @channel into their words, and keeps channels and pages as links", () => {
    const body = "Hi [@Ayşe](leafdesk:user/u1) and [@channel](leafdesk:everyone), see [Plan](leafdesk:page/p1) in [#design](leafdesk:channel/c1) or [@here](leafdesk:here)";
    const quiet = withoutCalls(body);
    expect(quiet).toBe("Hi @Ayşe and @channel, see [Plan](leafdesk:page/p1) in [#design](leafdesk:channel/c1) or @here");
    expect(mentionedUserIds(quiet)).toEqual([]);
    expect(broadcastOf(quiet)).toBeNull();
    expect(linkedPageIds(quiet)).toEqual(["p1"]);
  });

  it("leaves code and other links as they are", () => {
    const body = "Run `[@x](leafdesk:user/u1)` or read [docs](https://example.com)\n```\n[@here](leafdesk:here)\n```";
    expect(withoutCalls(body)).toBe(body);
  });
});
