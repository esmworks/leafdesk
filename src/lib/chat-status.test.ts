import { describe, expect, it } from "vitest";
import { conversationStatus } from "./chat-status";

const away = { answering: false, waiting: false };

describe("conversationStatus", () => {
  it("shows nothing for a conversation with nothing going on", () => {
    expect(conversationStatus({}, away, false)).toBeNull();
  });

  it("puts answering over waiting, and waiting over unread", () => {
    expect(conversationStatus({ answering: true, waiting: true, unread: true }, away, false)).toBe("answering");
    expect(conversationStatus({ waiting: true, unread: true }, away, false)).toBe("waiting");
    expect(conversationStatus({ unread: true }, away, false)).toBe("unread");
  });

  it("goes by what this tab knows of the answer it follows", () => {
    // The list read before the person decided: the tab knows it is answering again.
    expect(conversationStatus({ waiting: true }, { answering: true, waiting: false }, false)).toBe("answering");
    // The list read before the answer asked.
    expect(conversationStatus({ answering: true }, { answering: true, waiting: true }, false)).toBe("waiting");
  });

  it("marks nothing unread in the conversation the person has open", () => {
    expect(conversationStatus({ unread: true }, away, true)).toBeNull();
    // Waiting still shows there: the question is asked in it, but it may have scrolled away.
    expect(conversationStatus({ waiting: true }, away, true)).toBe("waiting");
  });
});
