import { describe, expect, it } from "vitest";
import { cosine, matchNotes, rankNotes } from "./memory-search";

const note = (id: string, text: string, details: string | null = null) => ({ id, text, details });

describe("matchNotes", () => {
  it("matches a word at the start of a note's words, in Turkish too", () => {
    const notes = [note("a", "Teklifler cuma günü çıkar"), note("b", "Note 13"), note("c", "Note 3"), note("d", "İzmir fabrikası")];
    expect(matchNotes(notes, "teklif").map((n) => n.id)).toEqual(["a"]);
    expect(matchNotes(notes, "3").map((n) => n.id)).toEqual(["c"]);
    expect(matchNotes(notes, "izmir").map((n) => n.id)).toEqual(["d"]);
    expect(matchNotes(notes, "klif")).toEqual([]);
  });
});

describe("rankNotes", () => {
  const notes = [
    note("a", "Offers go out in EUR"),
    note("b", "Ready unit bill of materials", "Compressor 4 kW, two condenser fans."),
    note("c", "Prefers short answers"),
    note("d", "Ready units ship from the Izmir plant"),
  ];

  it("ranks by words alone without similarities", () => {
    expect(rankNotes(notes, "ready unit", null).map((n) => n.id)).toEqual(matchNotes(notes, "ready unit").map((n) => n.id));
    expect(rankNotes(notes, "ready unit", new Map()).map((n) => n.id)).toEqual(["d", "b"]);
  });

  it("finds a note by meaning that shares no word with the query, and puts one found both ways first", () => {
    // "price" is in no note; the embeddings say the EUR note and the bill of materials are about it.
    const ranked = rankNotes(notes, "ready unit price", new Map([["a", 0.82], ["b", 0.6]]));
    // b: second by words, second by meaning; d: first by words only; a: first by meaning only.
    expect(ranked.map((n) => n.id)).toEqual(["b", "d", "a"]);
  });

  it("keeps at most the limit, newer notes first on a tie", () => {
    expect(rankNotes(notes, "nothing matches", new Map([["a", 0.7], ["c", 0.7]]), 1).map((n) => n.id)).toEqual(["a"]);
    expect(rankNotes([note("x", "same"), note("y", "same")], "same", new Map([["x", 0.5], ["y", 0.5]])).map((n) => n.id)).toEqual(["y", "x"]);
  });
});

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal or empty vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
