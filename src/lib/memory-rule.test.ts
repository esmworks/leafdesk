import { describe, expect, it } from "vitest";
import { noteWrite } from "./memory-rule";

describe("noteWrite", () => {
  it("keeps what the person said in a clean turn, in the chat and for an agent", () => {
    expect(noteWrite({ agent: false, personSaid: true })).toBe("keep");
    expect(noteWrite({ agent: true, personSaid: true })).toBe("keep");
  });
  it("asks in the chat and proposes for an agent otherwise", () => {
    expect(noteWrite({ agent: false, personSaid: false })).toBe("ask");
    expect(noteWrite({ agent: true, personSaid: false })).toBe("propose");
  });
  it("asks in the chat while changes without asking are off", () => {
    expect(noteWrite({ agent: false, personSaid: true, askAll: true })).toBe("ask");
  });
});
