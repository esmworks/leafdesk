import { describe, expect, it } from "vitest";
import board from "./trello-fixture.json";
import { fast, randomTexts } from "./linear-fixtures";
import { ImportError } from "./result";
import { cardBody, isTrelloBoard, labelColor, parseTrelloExport, readTrelloBoard, trelloMarkdown } from "./trello";

const read = () => readTrelloBoard(parseTrelloExport(JSON.stringify(board)));
const card = (title: string) => read().cards.find((c) => c.title === title)!;

describe("Trello exports", () => {
  it("tells a board export from other JSON", () => {
    expect(isTrelloBoard(board)).toBe(true);
    expect(isTrelloBoard({ name: "x", lists: [] })).toBe(false);
    expect(isTrelloBoard([board])).toBe(false);
    expect(() => parseTrelloExport("{ not json")).toThrow(ImportError);
    expect(() => parseTrelloExport('{"pages": []}')).toThrow(expect.objectContaining({ code: "badTrello" }));
    expect(parseTrelloExport(`﻿${JSON.stringify({ name: "B", lists: [], cards: [] })}`).name).toBe("B");
  });

  it("keeps the open lists in board order and the cards in list and card order", () => {
    const result = read();
    expect(result.title).toBe("Website relaunch");
    expect(result.lists.map((l) => l.name)).toEqual(["Backlog", "In progress", "Review", "Done"]);
    expect(result.cards.map((c) => [c.title, result.lists[c.list].name])).toEqual([
      ["Draft the new homepage copy", "Backlog"],
      ["Set up staging server", "In progress"],
      ["Fix broken contact form", "In progress"],
      ["Write release notes", "Review"],
      ["Ship v2", "Done"],
    ]);
  });

  it("leaves out archived lists and cards, and the cards of archived lists, and counts them", () => {
    const result = read();
    expect(result.archived).toEqual({ lists: 1, cards: 2 });
    expect(result.cards.map((c) => c.title)).not.toContain("Old landing page A/B test");
    expect(result.cards.map((c) => c.title)).not.toContain("Mascot ideas");
  });

  it("makes labels options in the closest colors, one per name, with color-only labels kept apart when used", () => {
    const result = read();
    expect(result.labels).toEqual([
      { name: "Design", color: "green" },
      { name: "Bug", color: "red" },
      { name: "Backend", color: "blue" },
      { name: null, color: "yellow" },
      { name: "Frontend", color: "blue" },
      { name: "Blocked", color: "gray" },
      { name: null, color: "purple" },
    ]);
    const names = (c: { labels: number[] }) => c.labels.map((i) => result.labels[i].name ?? result.labels[i].color);
    expect(names(card("Draft the new homepage copy"))).toEqual(["Design", "yellow"]);
    // "Bug" and "bug" are one option.
    expect(names(card("Fix broken contact form"))).toEqual(["Bug"]);
    expect(names(card("Ship v2"))).toEqual(["Frontend", "Blocked", "purple"]);
  });

  it("maps Trello colors", () => {
    expect(labelColor("green_dark")).toBe("green");
    expect(labelColor("red_light")).toBe("red");
    expect(labelColor("sky")).toBe("blue");
    expect(labelColor("lime_dark")).toBe("green");
    expect(labelColor("black")).toBe("gray");
    expect(labelColor(null)).toBe("gray");
    expect(labelColor("pink")).toBe("pink");
  });

  it("lists the members cards name, without ones the board doesn't have", () => {
    const result = read();
    expect(result.members).toEqual([
      { id: "6710a1f2c3d4e5f6000000m1", fullName: "Ayşe Yılmaz", username: "aysey" },
      { id: "6710a1f2c3d4e5f6000000m2", fullName: "Bob Stone", username: "bobstone" },
    ]);
    expect(card("Set up staging server").members).toEqual(["6710a1f2c3d4e5f6000000m2"]);
    expect(card("Write release notes").members).toHaveLength(2);
  });

  it("makes start and due dates one date, a range when both are set in order", () => {
    expect(card("Draft the new homepage copy").dates).toBe("2026-11-03T09:00:00.000Z");
    expect(card("Fix broken contact form").dates).toBe("2026-10-20T07:00:00.000Z/2026-10-24T15:00:00.000Z");
    // The start is after the due date: only the due date is kept.
    expect(card("Set up staging server").dates).toBe("2026-10-10T12:00:00.000Z");
    expect(card("Set up staging server").complete).toBe(true);
    expect(card("Write release notes").dates).toBeNull();
  });

  it("joins a card's checklists into one, naming each list's items when there are several", () => {
    expect(card("Draft the new homepage copy").checklist).toEqual([
      { text: "Collect old copy", checked: true },
      { text: "Write first draft", checked: false },
      { text: "Review with marketing", checked: false },
    ]);
    expect(card("Fix broken contact form").checklist).toEqual([
      { text: "Deploy: Point the form at the new endpoint", checked: true },
      { text: "QA: Test on mobile", checked: false },
    ]);
    expect(read().checklistName).toBeNull();
    const single = { ...board, checklists: board.checklists.slice(0, 1) };
    expect(readTrelloBoard(single).checklistName).toBe("Checklist");
  });

  it("puts the first linked attachment in the link and the others in the body", () => {
    const draft = card("Draft the new homepage copy");
    expect(draft.link).toBe("https://www.figma.com/file/abc123/Homepage");
    expect(draft.attachments).toEqual([
      { name: "wireframe.png", url: "https://trello.com/1/cards/6710a1f2c3d4e5f6000000c1/attachments/6710a1f2c3d4e5f6000000f9/download/wireframe.png" },
    ]);
    const staging = card("Set up staging server");
    expect(staging.link).toBe("https://docs.example.com/runbooks/staging");
    expect(staging.attachments).toEqual([{ name: "Monitoring", url: "https://status.example.com/" }]);
  });

  it("reads comments oldest first and leaves out other actions and archived cards' comments", () => {
    expect(card("Fix broken contact form").comments.map((c) => [c.author, c.date])).toEqual([
      ["Ayşe Yılmaz", "2026-10-14T21:45:00.000Z"],
      ["Bob Stone", "2026-10-16T14:02:11.512Z"],
    ]);
    expect(read().cards.flatMap((c) => c.comments)).toHaveLength(2);
  });

  it("reads custom fields and their values", () => {
    const result = read();
    expect(result.customFields).toEqual([
      {
        id: "6710a1f2c3d4e5f6000000x1",
        name: "Priority",
        type: "select",
        options: [
          { id: "6710a1f2c3d4e5f6000000o1", name: "High", color: "red" },
          { id: "6710a1f2c3d4e5f6000000o2", name: "Low", color: "green" },
        ],
      },
      { id: "6710a1f2c3d4e5f6000000x2", name: "Estimate", type: "number" },
      { id: "6710a1f2c3d4e5f6000000x3", name: "Sprint", type: "text" },
      { id: "6710a1f2c3d4e5f6000000x4", name: "Reviewed", type: "checkbox" },
      { id: "6710a1f2c3d4e5f6000000x5", name: "Launch", type: "date" },
    ]);
    expect(card("Set up staging server").fields).toEqual({
      "6710a1f2c3d4e5f6000000x1": "6710a1f2c3d4e5f6000000o2",
      "6710a1f2c3d4e5f6000000x2": 5,
      "6710a1f2c3d4e5f6000000x3": "S42",
      "6710a1f2c3d4e5f6000000x4": true,
      "6710a1f2c3d4e5f6000000x5": "2026-11-15T09:00:00.000Z",
    });
    expect(card("Fix broken contact form").fields).toEqual({ "6710a1f2c3d4e5f6000000x1": "6710a1f2c3d4e5f6000000o1" });
  });

  it("refuses boards with more cards than an import takes", () => {
    const many = { name: "Big", lists: [{ id: "l", name: "L", pos: 1 }], cards: Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}`, name: `${i}`, idList: "l", pos: i })) };
    expect(() => readTrelloBoard(many)).toThrow(expect.objectContaining({ code: "tooManyRows" }));
  });
});

describe("Trello Markdown", () => {
  const links: Record<string, string> = { AbCd1234: "/w/ws/p/row-1" };
  const cardLink = (short: string) => links[short] ?? null;

  it("turns images into links, so nothing is loaded from elsewhere", () => {
    expect(trelloMarkdown("Look: ![Wireframe](https://trello.com/x/wireframe.png) and ![](https://e.com/a.png)")).toBe(
      "Look: [Wireframe](https://trello.com/x/wireframe.png) and [image](https://e.com/a.png)",
    );
  });

  it("points links to imported cards at their rows and drops preview titles", () => {
    expect(trelloMarkdown('[the card](https://trello.com/c/AbCd1234/1-draft "smartCard-inline")', cardLink)).toBe("[the card](/w/ws/p/row-1)");
    expect(trelloMarkdown("See https://trello.com/c/AbCd1234/1-draft now", cardLink)).toBe(
      "See [https://trello.com/c/AbCd1234/1-draft](/w/ws/p/row-1) now",
    );
    expect(trelloMarkdown("<https://trello.com/c/AbCd1234>", cardLink)).toBe("[https://trello.com/c/AbCd1234](/w/ws/p/row-1)");
    expect(trelloMarkdown("[https://trello.com/c/AbCd1234](https://trello.com/c/AbCd1234)", cardLink)).toBe(
      "[https://trello.com/c/AbCd1234](/w/ws/p/row-1)",
    );
    // Cards the import doesn't have, and other links, stay as they are (apart from preview titles).
    expect(trelloMarkdown("https://trello.com/c/ZZZZ9999/9-gone", cardLink)).toBe("https://trello.com/c/ZZZZ9999/9-gone");
    expect(trelloMarkdown('[x](https://e.com "smartCard-block")', cardLink)).toBe("[x](https://e.com)");
    expect(trelloMarkdown('[x](https://e.com "A title")', cardLink)).toBe('[x](https://e.com "A title")');
  });

  it("writes a card's body: description, other attachments, then comments with author and time", () => {
    const body = cardBody(card("Fix broken contact form"), { attachments: "Attachments", comments: "Comments" }, {
      timeZone: "Europe/Istanbul",
      cardLink,
    });
    expect(body).toBe(
      [
        "Reported by two visitors. The copy lives in [the homepage card](/w/ws/p/row-1).",
        "### Comments",
        "**Ayşe Yılmaz** · 2026-10-15 00:45",
        "The form posts to the old endpoint. **Can't reproduce** on Safari though.",
        "**Bob Stone** · 2026-10-16 17:02",
        "Deployed the fix to staging, see [https://trello.com/c/AbCd1234/1-draft-the-new-homepage-copy](/w/ws/p/row-1) for the copy it needs.",
      ].join("\n\n"),
    );
    expect(cardBody(card("Draft the new homepage copy"), { attachments: "Ekler", comments: "Yorumlar" })).toContain(
      "### Ekler\n\n- [wireframe.png](<https://trello.com/1/cards/6710a1f2c3d4e5f6000000c1/attachments/6710a1f2c3d4e5f6000000f9/download/wireframe.png>)",
    );
    expect(cardBody(card("Write release notes"), { attachments: "A", comments: "C" })).toBe("");
  });

  it("reads crafted descriptions in time growing with their length, as the regexes it replaces", () => {
    const link = (short: string) => (short.includes("b") ? null : `/row/${short}`);
    expect(fast(() => trelloMarkdown("![".repeat(500_000), link))).toBe("![".repeat(500_000));
    expect(fast(() => trelloMarkdown(`${"[".repeat(500_000)}x](https://trello.com/c/AAAAAAAA)`, link))).toBe(`${"[".repeat(500_000)}x](/row/AAAAAAAA)`);
    const CARD_URL = /^https?:\/\/trello\.com\/c\/([A-Za-z0-9]{8})(?:[/?#]|$)/;
    const LINKS = /\[([^\]\n]*)\]\(([^()\s]+)(?:\s+("[^"\n]*"))?\)|<(https?:\/\/[^<>\s]+)>|(https?:\/\/trello\.com\/c\/[A-Za-z0-9]{8}(?:\/[^\s()<>\]]*)?)/g;
    const before = (markdown: string) => {
      const card = (url: string) => {
        const short = CARD_URL.exec(url)?.[1];
        return short ? link(short) : null;
      };
      return markdown
        .replace(/\r\n?/g, "\n")
        .replace(/!\[([^\]\n]*)\]\(/g, (_, alt: string) => `[${alt || "image"}](`)
        .replace(LINKS, (match, text?: string, target?: string, title?: string, angled?: string, bare?: string) => {
          if (target !== undefined) {
            const to = card(target);
            if (to) return `[${text}](${to})`;
            return title && /^"smartCard-[a-z]+"$/.test(title) ? `[${text}](${target})` : match;
          }
          const url = angled ?? bare!;
          const to = card(url);
          return to ? `[${url}](${to})` : match;
        });
    };
    const pieces = ["[", "]", "(", ")", "![", "a", " ", "\n", "<", ">", "https://trello.com/c/AAAAAAAA", "https://trello.com/c/bbbbbbbb", '"smartCard-inline"', "h"];
    for (const text of randomTexts(pieces, 5000, 10)) expect(trelloMarkdown(text, link)).toBe(before(text));
  });
});
