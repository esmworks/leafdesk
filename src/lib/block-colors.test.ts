import { describe, expect, it } from "vitest";
import { EDITOR_DICTIONARY_LOADERS } from "@/i18n/blocknote/loaders";
import { BLOCK_COLORS, colorAliases } from "./block-colors";

describe("block colors", () => {
  it("are the colors every editor language names", async () => {
    for (const dictionary of await Promise.all(Object.values(EDITOR_DICTIONARY_LOADERS).map((load) => load()))) {
      expect(Object.keys(dictionary.color_picker.colors).sort()).toEqual([...BLOCK_COLORS].sort());
    }
  });

  it("are found by their English and local names and the given words, once each", () => {
    expect(colorAliases("red", "Kırmızı", ["renk", "metin", "Renk", ""])).toEqual(["red", "kırmızı", "renk", "metin"]);
    expect(colorAliases("blue", "Blue", ["color"])).toEqual(["blue", "color"]);
  });
});
