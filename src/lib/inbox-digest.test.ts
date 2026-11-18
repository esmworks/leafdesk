import { describe, expect, it } from "vitest";
import { digestLines, readInboxDigest, type DigestEntry } from "./inbox-digest";

const at = new Date("2026-11-19T09:00:00Z");
const entry = (id: string, over: Partial<DigestEntry> = {}): DigestEntry => ({
  id,
  kind: "comment",
  title: `Page ${id}`,
  line: "Ayşe commented",
  at,
  href: `/w/ws/p/${id}`,
  ...over,
});

describe("digestLines", () => {
  it("numbers the entries newest first with their kind, title, line and snippet", () => {
    const { text, refs, left } = digestLines([entry("a"), entry("b", { kind: "automation", snippet: "Stock\nis low" })], 10_000);
    expect(text).toContain('[1] 2026-11-19 09:00 UTC · comment · Page a: Ayşe commented');
    expect(text).toContain('[2] 2026-11-19 09:00 UTC · automation · Page b: Ayşe commented — "Stock is low"');
    expect([...refs.keys()]).toEqual([1, 2]);
    expect(left).toBe(0);
  });

  it("keeps the newest when they don't fit and counts the rest", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`n${i}`, { title: "x".repeat(100) }));
    const { refs, left, text } = digestLines(entries, 1_000);
    expect(refs.has(1)).toBe(true);
    expect(refs.has(30)).toBe(false);
    expect(left).toBe(30 - refs.size);
    expect(text.length).toBeLessThanOrEqual(1_000);
  });
});

describe("readInboxDigest", () => {
  const refs = new Map([1, 2, 3, 4].map((n) => [n, entry(`id${n}`)] as const));

  it("sorts items into groups by ref and keeps the model's text", () => {
    const answer = JSON.stringify({
      needsYou: [{ ref: 2, text: "Ayşe asks you to approve [2] the offer" }],
      updates: [{ ref: "[1]", text: "A comment" }],
      clearable: [{ ref: 3, text: "A reaction" }],
    });
    const digest = readInboxDigest(answer, refs, { left: 5 });
    expect(digest.groups.map((g) => g.key)).toEqual(["needsYou", "updates", "clearable"]);
    expect(digest.groups[0].items).toEqual([{ id: "id2", title: "Page id2", text: "Ayşe asks you to approve the offer", href: "/w/ws/p/id2" }]);
    expect(digest.groups[1].items.map((i) => i.id)).toEqual(["id1", "id4"]);
    expect(digest.read).toBe(4);
    expect(digest.left).toBe(5);
  });

  it("drops refs it wasn't given and repeats, and never links anything else", () => {
    const answer = '```json\n{"needsYou":[{"ref":9,"text":"Ghost"},{"ref":1,"text":"One"}],"clearable":[{"ref":1,"text":"Again"},{"text":"No ref"}]}\n```';
    const digest = readInboxDigest(answer, refs, { left: 0 });
    expect(digest.groups.find((g) => g.key === "needsYou")!.items.map((i) => i.id)).toEqual(["id1"]);
    expect(digest.groups.find((g) => g.key === "clearable")).toBeUndefined();
    const all = digest.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(all.sort()).toEqual(["id1", "id2", "id3", "id4"]);
  });

  it("puts everything under updates, with its own line, when the answer isn't the JSON asked for", () => {
    const digest = readInboxDigest("Sorry, I can't.", refs, { left: 0 });
    expect(digest.groups).toHaveLength(1);
    expect(digest.groups[0].key).toBe("updates");
    expect(digest.groups[0].items.map((i) => i.text)).toEqual(Array(4).fill("Ayşe commented"));
  });
});
