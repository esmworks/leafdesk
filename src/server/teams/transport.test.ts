import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

const { buttonCard, sentText, remember, takeAsked, teamsMessage, teamsTransport } = await import("./transport");

describe("teamsMessage", () => {
  it("sends text as Markdown with a summary that hides spoilers, and no card without buttons", () => {
    const message = teamsMessage("<b>Call</b> <tg-spoiler>token=1</tg-spoiler>");
    expect(message).toMatchObject({ type: "message", textFormat: "markdown", text: "**Call** ```\ntoken=1\n```", summary: "Call …", attachments: [] });
  });

  it("escapes plain text instead of reading it as the HTML subset", () => {
    expect(teamsMessage("a <b> & c", { plain: true }).text).toBe("a &lt;b> & c");
  });

  it("puts the buttons in a card of action sets, a press carrying the button's data", () => {
    const message = teamsMessage("Approve?", {
      buttons: [
        [
          { text: "Yes", data: "ap:1:y" },
          { text: "No", data: "ap:1:n" },
        ],
        [{ text: "Open", url: "https://leaf.test/w/1" }],
      ],
    });
    const card = (message.attachments as { contentType: string; content: { body: { type: string; actions: unknown[] }[] } }[])[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.body).toEqual([
      {
        type: "ActionSet",
        actions: [
          { type: "Action.Submit", title: "Yes", data: { leafdesk: "ap:1:y" } },
          { type: "Action.Submit", title: "No", data: { leafdesk: "ap:1:n" } },
        ],
      },
      { type: "ActionSet", actions: [{ type: "Action.OpenUrl", title: "Open", url: "https://leaf.test/w/1" }] },
    ]);
  });

  it("has no card for no buttons", () => {
    expect(buttonCard([])).toBeNull();
    expect(buttonCard([[]])).toBeNull();
  });
});

describe("what the bot remembers of its messages", () => {
  it("says a message as plain text, and nothing for one it never saw", () => {
    remember("c1", "m1", "<b>Hi</b> &amp; bye");
    expect(sentText("c1", "m1")).toBe("Hi & bye");
    expect(sentText("c1", "m2")).toBeNull();
  });

  it("answers a note asked for once, with the message asked about", async () => {
    expect(takeAsked("c1")).toBeNull();
    const send = vi.spyOn(teamsTransport, "send").mockResolvedValue("m9");
    await expect(teamsTransport.askForReply("c1", "Why?", "placeholder", "m5")).resolves.toBe("m5");
    expect(takeAsked("c1")).toBe("m5");
    expect(takeAsked("c1")).toBeNull();
    send.mockRestore();
  });

  it("sends and reads no files", async () => {
    await expect(teamsTransport.sendDocument("c1", { name: "a.txt", contentType: "text/plain", bytes: new Uint8Array() })).rejects.toMatchObject({ kind: "badRequest" });
    await expect(teamsTransport.downloadFile({ ref: "https://x" }, 10)).rejects.toMatchObject({ kind: "badRequest" });
  });
});
