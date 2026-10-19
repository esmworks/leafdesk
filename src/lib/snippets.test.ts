import { describe, expect, it } from "vitest";
import {
  checkSnippetInput,
  cleanTrigger,
  fillPlaceholders,
  isSnippetTrigger,
  matchSnippets,
  MAX_SNIPPET_BODY,
  parseSnippetImport,
  placeholderValues,
  preparePlaceholders,
  snippetExport,
  SnippetError,
  triggerFromTitle,
  type PlaceholderContext,
} from "./snippets";

// 19 October 2026, 21:05 UTC: the next day in Tokyo, the same evening in Istanbul (UTC+3).
const ctx: PlaceholderContext = {
  now: new Date("2026-10-19T21:05:00Z"),
  locale: "en-GB",
  timeZone: "Europe/Istanbul",
  me: "Ayşe *Yılmaz*",
  page: "Weekly sync #4",
};

describe("placeholders", () => {
  it("formats the date and time in the person's language and time zone", () => {
    expect(placeholderValues(ctx)).toMatchObject({ date: "20 October 2026", time: "00:05" });
    expect(placeholderValues({ ...ctx, timeZone: "America/New_York" })).toMatchObject({ date: "19 October 2026", time: "17:05" });
    expect(placeholderValues({ ...ctx, locale: "tr", timeZone: "UTC" }).date).toBe("19 Ekim 2026");
    expect(placeholderValues({ ...ctx, locale: "en-US", timeZone: "UTC" }).datetime).toMatch(/^October 19, 2026.*9:05\sPM$/);
  });

  it("falls back to the runtime's zone for a zone it doesn't know", () => {
    expect(() => placeholderValues({ ...ctx, timeZone: "Mars/Olympus" })).not.toThrow();
  });

  it("turns placeholders into tokens Markdown leaves alone, and fills them in the blocks' text", () => {
    const prepared = preparePlaceholders("# {{page}}\n\n**By {{ me }}** on {{DATE}}, {{unknown}} stays", ctx, "abc123");
    expect(prepared.markdown).not.toMatch(/\{\{\s*(page|me|date)\s*\}\}/i);
    expect(prepared.markdown).toContain("{{unknown}} stays");
    expect(prepared.markdown).toMatch(/^# ldsnipabc123pagex$/m);
    // What the parser would make of it: a heading and bold text, with the tokens in their text.
    const blocks = [
      { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "ldsnipabc123pagex", styles: {} }], children: [] },
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "By ldsnipabc123mex", styles: { bold: true } },
          { type: "link", href: "https://x", content: [{ type: "text", text: " on ldsnipabc123datex", styles: {} }] },
        ],
        children: [{ type: "paragraph", props: { title: "ldsnipabc123mex" }, content: [{ type: "text", text: "ldsnipabc123mex", styles: {} }], children: [] }],
      },
    ];
    fillPlaceholders(blocks, prepared.tokens);
    expect(blocks[0].content[0]).toMatchObject({ text: "Weekly sync #4" });
    // Markdown characters in a value stay plain text.
    expect(blocks[1].content[0]).toMatchObject({ text: "By Ayşe *Yılmaz*", styles: { bold: true } });
    expect(JSON.stringify(blocks[1].content[1])).toContain(" on 20 October 2026");
    expect(blocks[1].children[0].content[0].text).toBe("Ayşe *Yılmaz*");
    // Props are not text.
    expect(blocks[1].children[0].props.title).toBe("ldsnipabc123mex");
  });

  it("keeps datetime and date apart", () => {
    const prepared = preparePlaceholders("{{datetime}} / {{date}}", ctx, "n");
    const blocks = [{ type: "text", text: prepared.markdown }];
    fillPlaceholders(blocks, prepared.tokens);
    expect(blocks[0].text).toBe("20 October 2026 at 00:05 / 20 October 2026");
  });

  it("marks the first {{cursor}} and drops the others", () => {
    const prepared = preparePlaceholders("a {{cursor}} b {{ CURSOR }} c", ctx, "z9");
    expect(prepared.cursor).toBe("ldsnipz9c");
    expect(prepared.markdown).toBe("a ldsnipz9c b  c");
    expect(preparePlaceholders("no caret", ctx, "z9").cursor).toBeNull();
  });
});

describe("triggers", () => {
  it("accepts lowercase letters, digits, - and _ up to 32 characters", () => {
    expect(isSnippetTrigger("standup-2025_q4")).toBe(true);
    expect(isSnippetTrigger("x".repeat(32))).toBe(true);
    expect(isSnippetTrigger("x".repeat(33))).toBe(false);
    expect(isSnippetTrigger("Meeting")).toBe(false);
    expect(isSnippetTrigger("toplantı")).toBe(false);
    expect(isSnippetTrigger("a b")).toBe(false);
    expect(isSnippetTrigger("")).toBe(false);
  });

  it("cleans what was typed and makes one from a title", () => {
    expect(cleanTrigger("  Daily Log ")).toBe("daily-log");
    expect(triggerFromTitle("Toplantı notları")).toBe("toplanti-notlari");
    expect(triggerFromTitle("Größe & Çözüm: 2026!")).toBe("grosse-cozum-2026");
    expect(triggerFromTitle("—")).toBe("");
    expect(triggerFromTitle("a".repeat(40)).length).toBe(32);
  });

  it("checks a whole snippet", () => {
    expect(checkSnippetInput({ trigger: "Log", title: "", body: "x\r\ny" })).toEqual({ trigger: "log", title: "log", body: "x\ny" });
    const code = (input: Parameters<typeof checkSnippetInput>[0]) => {
      try {
        checkSnippetInput(input);
        return null;
      } catch (error) {
        return (error as SnippetError).code;
      }
    };
    expect(code({ trigger: "", body: "x" })).toBe("triggerRequired");
    expect(code({ trigger: "no/slash", body: "x" })).toBe("triggerInvalid");
    expect(code({ trigger: "ok", title: "t".repeat(121), body: "x" })).toBe("titleTooLong");
    expect(code({ trigger: "ok", body: "  \n " })).toBe("bodyRequired");
    expect(code({ trigger: "ok", body: "x".repeat(MAX_SNIPPET_BODY + 1) })).toBe("bodyTooLong");
  });
});

describe("matchSnippets", () => {
  const list = [
    { trigger: "standup-2025", title: "Daily standup" },
    { trigger: "standup", title: "Standup (short)" },
    { trigger: "log", title: "Dated log line" },
    { trigger: "decision", title: "Karar kaydı" },
    { trigger: "mtg-notes", title: "Meeting notes" },
  ];
  const triggers = (query: string) => matchSnippets(query, list).map((s) => s.trigger);

  it("lists everything for an empty query, by trigger", () => {
    expect(triggers("")).toEqual(["decision", "log", "mtg-notes", "standup", "standup-2025"]);
  });

  it("ranks the trigger itself, then triggers starting with the query, then the rest", () => {
    expect(triggers("standup")).toEqual(["standup", "standup-2025"]);
    expect(triggers("st")).toEqual(["standup", "standup-2025"]);
    expect(triggers("notes")).toEqual(["mtg-notes"]);
    // A title match comes after trigger matches.
    expect(matchSnippets("de", [...list, { trigger: "x", title: "Design" }]).map((s) => s.trigger)).toEqual(["decision", "x"]);
  });

  it("keeps hyphens and digits as part of the query", () => {
    expect(triggers("standup-")).toEqual(["standup-2025"]);
    expect(triggers("standup-20")).toEqual(["standup-2025"]);
    expect(triggers("2025")).toEqual(["standup-2025"]);
    expect(triggers("mtg-n")).toEqual(["mtg-notes"]);
    expect(triggers("standup-3")).toEqual([]);
  });

  it("matches titles too, whatever the case and the Turkish i", () => {
    expect(triggers("MEETING")).toEqual(["mtg-notes"]);
    expect(triggers("kaydi")).toEqual(["decision"]);
    expect(triggers("KAYDI")).toEqual(["decision"]);
    expect(triggers("dated")).toEqual(["log"]);
  });
});

describe("parseSnippetImport", () => {
  it("reads Leafdesk's own export back", () => {
    const file = JSON.stringify(snippetExport([{ trigger: "log", title: "Log", body: "**{{datetime}}**: {{cursor}}" }]));
    expect(parseSnippetImport(file)).toEqual({ snippets: [{ trigger: "log", title: "Log", body: "**{{datetime}}**: {{cursor}}" }], skipped: [] });
  });

  it("reads a list of { id, label }: the id is the trigger and title, the label the body", () => {
    const file = JSON.stringify([
      { id: "sig", label: "Best,\nAyşe" },
      { id: "Addr", label: "Somewhere 1" },
      { id: 42, label: "Numbers work" },
    ]);
    expect(parseSnippetImport(`﻿${file}`)).toEqual({
      snippets: [
        { trigger: "sig", title: "sig", body: "Best,\nAyşe" },
        { trigger: "addr", title: "Addr", body: "Somewhere 1" },
        { trigger: "42", title: "42", body: "Numbers work" },
      ],
      skipped: [],
    });
  });

  it("skips entries that break the rules, saying why", () => {
    const file = JSON.stringify({
      version: 1,
      snippets: [
        { trigger: "ok", title: "Fine", body: "x" },
        { trigger: "ok", title: "Again", body: "y" },
        { trigger: "bad trigger!", title: "", body: "x" },
        { trigger: "", body: "x" },
        { trigger: "empty", body: "" },
        { trigger: "huge", body: "x".repeat(MAX_SNIPPET_BODY + 1) },
        { trigger: "long-title", title: "t".repeat(200), body: "x" },
        { trigger: "nobody" },
      ],
    });
    const parsed = parseSnippetImport(file);
    expect(parsed.snippets.map((s) => s.trigger)).toEqual(["ok"]);
    expect(parsed.skipped).toEqual([
      { trigger: "ok", reason: "duplicate" },
      { trigger: "bad trigger!", reason: "triggerInvalid" },
      { trigger: "", reason: "triggerRequired" },
      { trigger: "empty", reason: "bodyRequired" },
      { trigger: "huge", reason: "bodyTooLong" },
      { trigger: "long-title", reason: "titleTooLong" },
      { trigger: "nobody", reason: "bodyRequired" },
    ]);
  });

  it("refuses files of neither shape", () => {
    const fails = (text: string) => {
      try {
        parseSnippetImport(text);
        return null;
      } catch (error) {
        return error instanceof SnippetError ? error.code : "other";
      }
    };
    expect(fails("not json")).toBe("importInvalid");
    expect(fails("{}")).toBe("importInvalid");
    expect(fails('{"version":2,"snippets":[]}')).toBe("importInvalid");
    expect(fails('{"version":1,"snippets":{}}')).toBe("importInvalid");
    expect(fails('{"version":1,"snippets":[1,2]}')).toBe("importInvalid");
    expect(fails('[{"label":"no id"}]')).toBe("importInvalid");
    expect(fails("[1]")).toBe("importInvalid");
    expect(fails("null")).toBe("importInvalid");
    expect(fails('"text"')).toBe("importInvalid");
    expect(fails("[]")).toBeNull();
  });
});
