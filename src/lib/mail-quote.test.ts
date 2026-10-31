import { describe, expect, it } from "vitest";
import { ownText, quoteStart } from "./mail-quote";

describe("quoteStart", () => {
  it("starts at the line introducing the quote, or the first quoted line", () => {
    expect(quoteStart(["Tamam.", "", "On Mon, Ada wrote:", "> soru"])).toBe(2);
    expect(quoteStart(["Tamam.", "> soru"])).toBe(1);
    expect(quoteStart(["Tamam.", "Teşekkürler"])).toBe(-1);
  });
});

describe("ownText", () => {
  it("keeps what the message itself says", () => {
    expect(ownText("Cuma olur.\r\n\r\n5 Eki 2026 tarihinde Ada şunu yazdı:\r\n> Cuma uygun mu?\r\n> Ada")).toBe("Cuma olur.");
    expect(ownText("Yalnızca bu.\n")).toBe("Yalnızca bu.");
  });
});
