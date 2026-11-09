import { describe, expect, it } from "vitest";
import { payloadOf, slackPayloadBody } from "./slack-payload";

const body = (payload: unknown) => {
  const result = slackPayloadBody(payload);
  if (!result.ok) throw new Error(result.error);
  return result.body;
};

describe("slackPayloadBody", () => {
  it("reads mrkdwn text: bold, links, emoji names", () => {
    expect(body({ text: "Deploy *finished* :tada: <https://ci.example.com/42|build 42>" })).toBe("Deploy **finished** 🎉 [build 42](https://ci.example.com/42)");
  });

  it("refuses what isn't a payload, and one with nothing to say", () => {
    expect(slackPayloadBody("hello")).toEqual({ ok: false, error: "invalid_payload" });
    expect(slackPayloadBody([])).toEqual({ ok: false, error: "invalid_payload" });
    expect(slackPayloadBody({ text: "  " })).toEqual({ ok: false, error: "no_text" });
  });

  it("shows blocks in place of the text", () => {
    const b = body({
      text: "fallback",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Alert firing" } },
        { type: "section", text: { type: "mrkdwn", text: "*CPU* at 95%" }, fields: [{ type: "mrkdwn", text: "*Host*\nweb-1" }] },
        { type: "divider" },
        { type: "context", elements: [{ type: "mrkdwn", text: "Grafana" }, { type: "image", image_url: "https://x.example.com/i.png", alt_text: "" }] },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: "https://grafana.example.com/d/1" }, { type: "button", text: { type: "plain_text", text: "Ack" }, action_id: "ack" }] },
        { type: "image", image_url: "https://x.example.com/graph.png", alt_text: "CPU graph" },
      ],
    });
    expect(b).toBe(
      "### Alert firing\n\n**CPU** at 95%\n\n- **Host** web-1\n\n---\n\nGrafana\n\n[Open](https://grafana.example.com/d/1)\n\n[CPU graph](https://x.example.com/graph.png)",
    );
    expect(b).not.toContain("fallback");
  });

  it("writes attachments as quoted cards under the text", () => {
    const b = body({
      text: "Alerts",
      attachments: [{ color: "#f00", title: "Disk full", title_link: "https://a.example.com", text: "on *db-1*", fields: [{ title: "Usage", value: "99%" }], footer: "Alertmanager" }],
    });
    expect(b).toBe("Alerts\n\n> **[Disk full](https://a.example.com)**\n> on **db-1**\n> **Usage**: 99%\n> _Alertmanager_");
  });

  it("keeps only web links and escapes plain text", () => {
    expect(body({ blocks: [{ type: "section", text: { type: "plain_text", text: "*not bold* [x](y)" }, accessory: { type: "button", text: { type: "plain_text", text: "Go" }, url: "javascript:alert(1)" } }] })).toBe(
      "\\*not bold\\* \\[x\\](y)\n\nGo",
    );
  });

  it("reads rich text", () => {
    expect(
      body({
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: "rich_text_section", elements: [{ type: "text", text: "Hi ", style: {} }, { type: "text", text: "there", style: { bold: true } }, { type: "emoji", name: "wave", unicode: "1f44b" }] },
              { type: "rich_text_list", style: "bullet", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "one" }] }] },
            ],
          },
        ],
      }),
    ).toBe("Hi **there**👋\n\n- one");
  });

  it("cuts a body that's too long", () => {
    expect(body({ text: "a".repeat(50_000) }).length).toBe(40_000);
  });
});

describe("payloadOf", () => {
  it("reads JSON and a form's payload field", () => {
    expect(payloadOf("application/json", '{"text":"x"}')).toEqual({ text: "x" });
    expect(payloadOf("application/x-www-form-urlencoded", `payload=${encodeURIComponent('{"text":"y"}')}`)).toEqual({ text: "y" });
    expect(payloadOf("application/json", "{")).toBeNull();
  });
});
