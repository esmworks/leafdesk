import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { teamsTenantId: "tenant-1", teamsAppId: "app", teamsAppPassword: "p", teamsServiceUrlHosts: [] } }));
vi.mock("@/server/chat-apps/bot", async () => {
  const COMMANDS = ["new", "workspace", "agent", "mode", "stop", "notifications", "unlink", "help"];
  const commandOf = (text: string) => {
    const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    return match ? { command: match[1].toLowerCase(), rest: (match[2] ?? "").trim() } : null;
  };
  return { COMMANDS, commandOf, handleEvent: vi.fn() };
});
vi.mock("./conversations", () => ({ rememberServiceUrl: vi.fn(async () => true) }));
vi.mock("./transport", () => ({ dropAsked: vi.fn(), sentText: (chat: string, id: string) => (id === "m1" ? "Approve this?" : null), takeAsked: vi.fn(() => null), teamsTransport: {} }));

const { bareCommand, eventOf, fromOurTenant } = await import("./events");
const transport = await import("./transport");

const base = { type: "message", id: "a1", serviceUrl: "https://smba.trafficmanager.net/emea/", channelId: "msteams", locale: "tr-TR", from: { id: "29:abc", name: "Alice" }, conversation: { id: "a:1x", conversationType: "personal", tenantId: "tenant-1" } };

describe("bareCommand", () => {
  it("takes a message that is one command alone, or `link` with its code, or `new summary`", () => {
    expect(bareCommand("help")).toEqual({ command: "help", rest: "" });
    expect(bareCommand(" New ")).toEqual({ command: "new", rest: "" });
    expect(bareCommand("new summary")).toEqual({ command: "new", rest: "summary" });
    expect(bareCommand("link AbCdEfGhIjKlMnOpQrStUvWx")).toEqual({ command: "link", rest: "AbCdEfGhIjKlMnOpQrStUvWx" });
  });

  it("leaves a question that only starts with such a word", () => {
    for (const text of ["help me with the tyre vendors", "new customers this week", "stop the production line?", "link the page", "link short", "hello"]) expect(bareCommand(text), text).toBeNull();
  });
});

describe("eventOf", () => {
  it("reads a message in a personal chat, with the person and their language", () => {
    expect(eventOf({ ...base, text: "What changed?" })).toEqual({
      kind: "message",
      from: { id: "29:abc", name: "Alice", username: null, languageCode: "tr-TR" },
      chat: { id: "a:1x", private: true },
      text: "What changed?",
      command: null,
    });
  });

  it("reads commands with or without a slash, after the bot's mention", () => {
    expect(eventOf({ ...base, text: "<at>Leafdesk</at> /link CODE123" })).toMatchObject({ text: "", command: { command: "link", rest: "CODE123" } });
    expect(eventOf({ ...base, text: "/new summary" })).toMatchObject({ command: { command: "new", rest: "summary" } });
    expect(eventOf({ ...base, text: "stop" })).toMatchObject({ command: { command: "stop", rest: "" } });
    expect(transport.dropAsked).toHaveBeenCalled();
  });

  it("marks chats other than a personal one", () => {
    expect(eventOf({ ...base, conversation: { id: "19:c@thread.v2", conversationType: "channel" }, text: "hi" })).toMatchObject({ chat: { private: false } });
  });

  it("reads a press of the bot's button from the message carrying its data", () => {
    expect(eventOf({ ...base, text: "", value: { leafdesk: "ap:run1:y" }, replyToId: "m1" })).toEqual({
      kind: "button",
      from: { id: "29:abc", name: "Alice", username: null, languageCode: "tr-TR" },
      chat: { id: "a:1x" },
      messageId: "m1",
      messageText: "Approve this?",
      data: "ap:run1:y",
      callbackId: "a1",
    });
    expect(eventOf({ ...base, value: { leafdesk: "ap:x:y" } })).toBeNull();
    expect(eventOf({ ...base, value: { other: 1 }, text: "x" })).toMatchObject({ kind: "message" });
  });

  it("answers the note it asked for with the person's next message", () => {
    vi.mocked(transport.takeAsked).mockReturnValueOnce("m7");
    expect(eventOf({ ...base, text: "make it shorter" })).toMatchObject({ replyTo: "m7", text: "make it shorter" });
  });

  it("ignores what isn't a message", () => {
    expect(eventOf({ ...base, type: "conversationUpdate" })).toBeNull();
    expect(eventOf({ ...base, from: {} , text: "x" })).toBeNull();
  });
});

describe("fromOurTenant", () => {
  it("answers only people of the bot's own directory", () => {
    expect(fromOurTenant({ channelData: { tenant: { id: "TENANT-1" } } })).toBe(true);
    expect(fromOurTenant({ conversation: { id: "x", tenantId: "tenant-1" } })).toBe(true);
    expect(fromOurTenant({ channelData: { tenant: { id: "tenant-2" } } })).toBe(false);
    expect(fromOurTenant({})).toBe(false);
  });
});
