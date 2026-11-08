import { describe, expect, it } from "vitest";
import { channelThreadBefore } from "./agent-channel";

const message = (id: string, authorId: string | null, body: string, extra: { kind?: "message" | "system"; deletedAt?: string | null } = {}) => ({
  id,
  authorId,
  body,
  kind: extra.kind ?? ("message" as const),
  deletedAt: extra.deletedAt ?? null,
});
const names: Record<string, string> = { a: "Ayşe", b: "Bora" };
const nameOf = (id: string | null) => (id && names[id]) || "Someone";

describe("channelThreadBefore", () => {
  it("lists the thread before the message, oldest first, by writer, as plain words", () => {
    const thread = [
      message("1", "a", "Is the **launch** still on?"),
      message("2", "b", "Ask [@Ayşe](leafdesk:user/a)\nshe knows"),
      message("3", "a", "Asking the agent"),
      message("4", "b", "after"),
    ];
    expect(channelThreadBefore(thread, "3", nameOf, { max: 10, chars: 1000 })).toEqual(["Ayşe: Is the launch still on?", "Bora: Ask @Ayşe she knows"]);
  });

  it("leaves out system lines, deleted messages and empty ones, and is empty for a thread's first message", () => {
    const thread = [message("1", "a", "joined", { kind: "system" }), message("2", "b", "gone", { deletedAt: "2026-11-08T00:00:00Z" }), message("3", "b", "  "), message("4", null, "kept"), message("5", "a", "now")];
    expect(channelThreadBefore(thread, "5", nameOf, { max: 10, chars: 1000 })).toEqual(["Someone: kept"]);
    expect(channelThreadBefore(thread, "1", nameOf, { max: 10, chars: 1000 })).toEqual([]);
  });

  it("keeps the newest lines when they don't all fit", () => {
    const thread = [message("1", "a", "x".repeat(50)), message("2", "b", "second"), message("3", "a", "third"), message("4", "b", "ask")];
    expect(channelThreadBefore(thread, "4", nameOf, { max: 2, chars: 1000 })).toEqual(["Bora: second", "Ayşe: third"]);
    expect(channelThreadBefore(thread, "4", nameOf, { max: 10, chars: 30 })).toEqual(["Bora: second", "Ayşe: third"]);
  });
});
