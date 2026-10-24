import { describe, expect, it } from "vitest";
import { foldName, indexNames, matchScore, searchByNames } from "./emoji-search";

describe("emoji search", () => {
  it("folds case, accents and the Turkish dotless i", () => {
    expect(foldName("Güneş")).toBe("gunes");
    expect(foldName("KALP")).toBe("kalp");
    expect(foldName("Işık")).toBe("isik");
  });

  it("ranks a name that starts with the query over a keyword", () => {
    const sun = indexNames("güneş|gök|hava|parlak");
    const weather = indexNames("bulutlu|güneş arkasında|hava");
    expect(matchScore(sun, "gun")).toBe(0);
    expect(matchScore(weather, "gunes")).toBe(2);
    expect(matchScore(sun, "kar")).toBeNull();
  });

  it("matches every word of the query", () => {
    const hand = indexNames("waving hand|bye|hello|wave");
    expect(matchScore(hand, "hand wav")).toBe(1);
    expect(matchScore(hand, "hand hi")).toBeNull();
    expect(matchScore(hand, "hello wave")).toBe(2);
  });

  it("lists matches best first, keeping their order otherwise", () => {
    const names: Record<string, string> = { "🌞": "sun with face|sun", "☀️": "sun|sunny", "🌻": "sunflower|flower|sun", "🐈": "cat" };
    const found = searchByNames(Object.keys(names), (e) => indexNames(names[e]), "sun");
    expect(found).toEqual(["🌞", "☀️", "🌻"]);
    expect(searchByNames(Object.keys(names), (e) => indexNames(names[e]), "  ")).toEqual([]);
  });
});
