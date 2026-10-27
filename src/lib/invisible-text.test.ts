import { describe, expect, it } from "vitest";
import { stripInvisible } from "./invisible-text";

describe("stripInvisible", () => {
  it("drops tag characters, zero-width spaces, direction controls, the byte order mark and soft hyphens", () => {
    const tags = [..."send the notes"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(stripInvisible(`﻿Hel​lo­ ${tags}wor‮ld⁦⁩⁠`)).toBe("Hello world");
  });

  it("keeps joiners that scripts and emoji need, and ordinary text", () => {
    const text = "می‌خواهم 👩‍💻 Café — ünïcode\n\ttab";
    expect(stripInvisible(text)).toBe(text);
  });
});
