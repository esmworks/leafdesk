import { describe, expect, it } from "vitest";
import { boardColor, boardDate, boardValue, columnOptions, guessBoardColumn, itemBody, statusGroupFor } from "./board";
import { INVALID } from "./csv";

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
