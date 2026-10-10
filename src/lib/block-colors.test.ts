import { describe, expect, it } from "vitest";
import { de, en, es, fr } from "@blocknote/core/locales";
import { tr } from "@/i18n/blocknote/tr";
import { BLOCK_COLORS, colorAliases } from "./block-colors";

describe("block colors", () => {
  it("are the colors every editor language names", () => {
    for (const dictionary of [en, tr, de, es, fr]) {
      expect(Object.keys(dictionary.color_picker.colors).sort()).toEqual([...BLOCK_COLORS].sort());
    }
  });

  it("are found by their English and local names and the given words, once each", () => {
    expect(colorAliases("red", "Kırmızı", ["renk", "metin", "Renk", ""])).toEqual(["red", "kırmızı", "renk", "metin"]);
    expect(colorAliases("blue", "Blue", ["color"])).toEqual(["blue", "color"]);
  });
});
