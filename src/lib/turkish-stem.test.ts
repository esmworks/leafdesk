import { describe, expect, it } from "vitest";
import { turkishRoots } from "./turkish-stem";

describe("turkishRoots", () => {
  it("takes off one case, possessive or plural ending", () => {
    expect(turkishRoots("farkı")).toEqual(["fark"]);
    expect(turkishRoots("notlar")).toEqual(["not"]);
    expect(turkishRoots("teklifleri")).toEqual(["teklif"]);
    expect(turkishRoots("fabrikadan")).toEqual(["fabrika"]);
  });

  it("gives the root's hard last letter back too", () => {
    expect(turkishRoots("kitabı")).toEqual(["kitab", "kitap"]);
    expect(turkishRoots("örneği")).toEqual(["örneğ", "örnek"]);
  });

  it("leaves short words and words without an ending as they are", () => {
    expect(turkishRoots("evi")).toEqual([]);
    expect(turkishRoots("adı")).toEqual([]);
    expect(turkishRoots("fark")).toEqual([]);
    expect(turkishRoots("taxi")).toEqual([]);
  });
});
