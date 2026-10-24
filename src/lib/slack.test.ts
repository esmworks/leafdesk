import { describe, expect, it } from "vitest";
import { escapeSlack, escapeSlackValues, slackPayload, slackUrlHint, slackWebhookUrl } from "./slack";

const HOOK = "https://hooks.slack.com/services/T0001/B0002/abcdEFGHijkl1234";

describe("a Slack webhook address", () => {
  it("takes Slack's incoming webhooks", () => {
    expect(slackWebhookUrl(HOOK)?.toString()).toBe(HOOK);
    expect(slackWebhookUrl(`  ${HOOK} `)?.toString()).toBe(HOOK);
  });

  it("refuses anything else", () => {
    for (const bad of [
      "http://hooks.slack.com/services/T0001/B0002/x",
      "https://hooks.slack.com.evil.example/services/T/B/x",
      "https://evil.example/hooks.slack.com/services/T/B/x",
      "https://user:pw@hooks.slack.com/services/T/B/x",
      "https://hooks.slack.com:8443/services/T/B/x",
      "https://hooks.slack.com/",
      "https://hooks.slack.com/services/",
      "https://slack.com/api/chat.postMessage",
      "not a url",
      "",
      42,
    ]) {
      expect(slackWebhookUrl(bad), String(bad)).toBeNull();
    }
  });

  it("takes an address on a host the administrator allows", () => {
    const allowed = (url: URL) => url.host === "127.0.0.1:4000";
    expect(slackWebhookUrl("http://127.0.0.1:4000/hooks/abc", allowed)?.toString()).toBe("http://127.0.0.1:4000/hooks/abc");
    expect(slackWebhookUrl("http://127.0.0.1:4001/hooks/abc", allowed)).toBeNull();
  });

  it("shows only a hint of a saved address", () => {
    expect(slackUrlHint(HOOK)).toBe("hooks.slack.com/services/…1234");
    expect(slackUrlHint(HOOK)).not.toContain("B0002");
    expect(slackUrlHint("nope")).toBe("…");
  });
});

describe("the message Slack gets", () => {
  it("escapes what Slack reads as markup", () => {
    expect(escapeSlack("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(escapeSlackValues({ title: "<!channel>", list: ["x&y"], n: 3, none: null })).toEqual({
      title: "&lt;!channel&gt;",
      list: ["x&amp;y"],
      n: 3,
      none: null,
    });
  });

  it("puts the row's link on a line of its own", () => {
    expect(slackPayload("*Done*: Fix login", { url: "https://app.example/w/1/p/2", title: "Fix <login> | now" })).toEqual({
      text: "*Done*: Fix login\n<https://app.example/w/1/p/2|Fix &lt;login&gt; ∣ now>",
    });
  });

  it("sends the link alone without a message, and the message alone without a link", () => {
    expect(slackPayload("  ", { url: "https://app.example/x", title: "" })).toEqual({ text: "<https://app.example/x|https://app.example/x>" });
    expect(slackPayload("Hello", null)).toEqual({ text: "Hello" });
    expect(slackPayload("Hello", { url: "javascript:alert(1)", title: "x" })).toEqual({ text: "Hello" });
  });
});
