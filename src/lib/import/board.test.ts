import { describe, expect, it } from "vitest";
import { formatCoordinates, MAX_PLACE_ADDRESS, parseCoordinates } from "../place";
import { isEmailAddress } from "../properties";
import { boardColor, boardDate, boardMarkdown, boardPlace, boardValue, columnOptions, guessBoardColumn, itemBody, oneLine, statusGroupFor } from "./board";
import { INVALID } from "./csv";
import { fast, randomTexts } from "./linear-fixtures";

describe("board imports", () => {
  it("puts status options in groups by their names", () => {
    expect(["Done", "Completed", "Tamamlandı", "Erledigt", "Working on it", "Stuck", "In review", "Not started", "", "Ideas"].map(statusGroupFor)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "in_progress",
      "in_progress",
      "in_progress",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("maps app colors to the nearest of Leafdesk's", () => {
    expect(["dark-red", "light-teal", "hot-pink", "yellow-green", "light-warm-gray", "none", null].map(boardColor)).toEqual([
      "red",
      "blue",
      "pink",
      "green",
      "gray",
      undefined,
      undefined,
    ]);
  });

  it("reads dates, times and ranges written either way", () => {
    expect(boardDate("2026-10-01 - 2026-10-05", "iso")).toBe("2026-10-01/2026-10-05");
    expect(boardDate("2026-10-01/2026-10-05", "iso")).toBe("2026-10-01/2026-10-05");
    expect(boardDate("2026-10-05 - 2026-10-01", "iso")).toBe("2026-10-01");
    expect(boardDate("2026-10-01T09:00:00", "iso", "Europe/Istanbul")).toBe("2026-10-01T06:00:00.000Z");
    expect(boardDate("soon", "iso")).toBeNull();
  });

  it("turns cells into values of each type", () => {
    expect(boardValue("url", "Docs - https://docs.example.com/a")).toBe("https://docs.example.com/a");
    expect(boardValue("email", "Ada - ada@example.com")).toBe("ada@example.com");
    expect(boardValue("checkbox", "v")).toBe(true);
    expect(boardValue("checkbox", "maybe")).toBe(INVALID);
    expect(boardValue("number", "$1,200")).toBe(1200);
    expect(boardValue("multi_select", "Social, Paid")).toEqual(["Social", "Paid"]);
    expect(boardValue("text", ["a", "b"])).toBe("a, b");
    expect(boardValue("person", [{ name: "Ada", email: "ada@example.com" }])).toEqual([{ name: "Ada", email: "ada@example.com" }]);
    expect(boardValue("person", "Ada, Bob")).toEqual([
      { name: "Ada", email: null },
      { name: "Bob", email: null },
    ]);
    expect(boardValue("date", "")).toBeNull();
  });

  it("reads places that carry their coordinates, and no address alone", () => {
    expect(boardPlace("Galata Tower, Istanbul (41.0256, 28.9741)")).toEqual({ address: "Galata Tower, Istanbul", lat: 41.0256, lng: 28.9741 });
    expect(boardPlace("Sydney Opera House - -33.8568, 151.2153")).toEqual({ address: "Sydney Opera House", lat: -33.8568, lng: 151.2153 });
    expect(boardPlace("41.0082, 28.9784")).toEqual({ address: "41.0082, 28.9784", lat: 41.0082, lng: 28.9784 });
    expect(boardPlace("Galata Tower, Istanbul")).toBeNull();
    expect(boardValue("place", "Galata Tower, Istanbul")).toBe(INVALID);
  });

  it("guesses labelled links and Monday's checkboxes", () => {
    expect(guessBoardColumn(["Docs - https://a.example", "Spec - https://b.example"]).type).toBe("url");
    expect(guessBoardColumn(["v", "", "v"]).type).toBe("checkbox");
    expect(guessBoardColumn(["2026-10-01 - 2026-10-05"]).type).toBe("date");
  });

  it("keeps the export's options and colors, adding values it didn't list", () => {
    const column = { name: "Priority", type: "select" as const, options: [{ name: "High", color: "red" as const }] };
    expect(columnOptions(column, "select", ["Low", "high", ""])).toEqual([{ name: "High", color: "red" }, { name: "Low" }]);
    expect(columnOptions(column, "status", ["Done"])).toEqual([{ name: "Done", group: "done" }]);
    expect(columnOptions({ name: "Tags", type: "multi_select" }, "multi_select", [["a", "b"], "b, c"]).map((o) => o.name)).toEqual(["a", "b", "c"]);
  });

  it("writes an item's body with its links to other items, attachments and comments", () => {
    const body = itemBody(
      {
        body: "See https://app.example/1 and ![shot](https://img.example/x.png)",
        attachments: [{ name: "spec_v2.pdf", url: "https://files.example/spec" }],
        comments: [
          { author: "Ada", date: "2026-10-01T08:00:00.000Z", text: "First [one](https://app.example/1)" },
          { author: "Bob", date: null, text: "Undated" },
        ],
      },
      { attachments: "Attachments", comments: "Comments" },
      { timeZone: "Europe/Istanbul", itemLink: (url) => (url === "https://app.example/1" ? "/w/ws/p/row1" : null) },
    );
    expect(body).toBe(
      [
        "See [https://app.example/1](/w/ws/p/row1) and [shot](https://img.example/x.png)",
        "### Attachments",
        "- [spec\\_v2.pdf](<https://files.example/spec>)",
        "### Comments",
        "**Ada** · 2026-10-01 11:00",
        "First [one](/w/ws/p/row1)",
        "**Bob**",
        "Undated",
      ].join("\n\n"),
    );
  });
});

describe("crafted exports are read in time growing with their length", () => {
  it("places, email addresses, dates and long cells", () => {
    expect(fast(() => boardPlace(`a${" ".repeat(1_000_000)}x`))).toBeNull();
    expect(fast(() => boardPlace(`a${" - ".repeat(100_000)}\nx`))).toBeNull();
    expect(fast(() => boardPlace(`Tower${" ".repeat(300_000)}(41.0256, 28.9741)`))).toEqual({ address: "Tower", lat: 41.0256, lng: 28.9741 });
    expect(fast(() => boardValue("email", "a".repeat(1_000_000)))).toBe(INVALID);
    expect(fast(() => boardValue("email", `${"a@".repeat(300_000)} - ada@example.com`))).toBe("ada@example.com");
    expect(fast(() => boardValue("email", `${"a ".repeat(300_000)} - ada@example.com`))).toBe("ada@example.com");
    expect(fast(() => guessBoardColumn(["x".repeat(500_000)]))).toEqual({ type: "text" });
    expect(fast(() => boardDate(`2026-10-01${" ".repeat(300_000)}x`, "iso"))).toBeNull();
    expect(fast(() => boardMarkdown("![".repeat(500_000)))).toBe("![".repeat(500_000));
    expect(fast(() => boardMarkdown(`${"[".repeat(500_000)}x](https://a.example/b)`, () => "/row"))).toBe(`${"[".repeat(500_000)}x](/row)`);
  });

  it("reads places, email addresses and Markdown links as the regexes they replace", () => {
    const placeBefore = (raw: string) => {
      const s = raw.trim();
      const whole = parseCoordinates(s);
      if (whole) return { address: formatCoordinates(whole.lat, whole.lng), ...whole };
      const m = /^(.+?)\s*(?:\(([^()]+)\)|\[([^[\]]+)\]|\s-\s+(.+))$/.exec(s);
      const coords = m && parseCoordinates(m[2] ?? m[3] ?? m[4]);
      if (!m || !coords) return null;
      return { address: oneLine(m[1]).slice(0, MAX_PLACE_ADDRESS) || formatCoordinates(coords.lat, coords.lng), ...coords };
    };
    const places = ["41.0, 28.9", " (", "(", ")", "[", "]", " - ", "-", " ", "\n", "a", "b", "\t"];
    for (const text of randomTexts(places, 5000, 10)) expect(boardPlace(text)).toEqual(placeBefore(text));

    const emailBefore = (raw: string) => {
      const found = /[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+/.exec(raw.replace(/^mailto:/i, ""))?.[0];
      return found && isEmailAddress(found) ? found : INVALID;
    };
    const emails = ["a", "@", ".", " ", "-", "mailto:", "b.c", ",", "<", "x@y.z", "@@", ".."];
    for (const text of randomTexts(emails, 5000, 10)) if (text.trim()) expect(boardValue("email", text)).toEqual(emailBefore(text.trim()));

    const LINKS = /\[([^\]\n]*)\]\(([^()\s]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^<>\s]+)>|(https?:\/\/[^\s()<>\]]+)/g;
    const itemLink = (url: string) => (url.includes("b") ? null : `/row/${url.length}`);
    const markdownBefore = (markdown: string) =>
      markdown
        .replace(/\r\n?/g, "\n")
        .replace(/!\[([^\]\n]*)\]\(/g, (_, alt: string) => `[${alt || "image"}](`)
        .replace(LINKS, (match, text?: string, target?: string, angled?: string, bare?: string) => {
          const url = target ?? angled ?? bare!;
          const to = itemLink(url);
          if (!to) return match;
          return target !== undefined ? `[${text}](${to})` : `[${url}](${to})`;
        });
    const pieces = ["[", "]", "(", ")", "!", "![", "a", " ", "\n", "<", ">", "http://x", "https://b", '"t"', "h", "](a)"];
    for (const text of randomTexts(pieces, 5000, 12)) expect(boardMarkdown(text, itemLink)).toBe(markdownBefore(text));
  });
});
