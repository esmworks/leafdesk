import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { asanaTaskId, isAsanaJson, readAsanaExport } from "./asana";
import { ASANA_CSV, ASANA_JSON, AYSE_EMAIL } from "./board-fixtures";
import { csvTable } from "./csv";

const csv = () => readAsanaExport("Website_launch.csv", strToU8(ASANA_CSV));
const json = () => readAsanaExport("offsite.json", strToU8(JSON.stringify(ASANA_JSON)));
const task = (board: ReturnType<typeof csv>, title: string) => board.items.find((i) => i.title === title)!;
const titleOf = (board: ReturnType<typeof csv>, i: number | null) => (i === null ? null : board.items[i].title);

describe("Asana CSV exports", () => {
  it("names the database after the project most tasks are in, sections in the order they appear", () => {
    const board = csv();
    expect(board.source).toBe("asana");
    expect(board.title).toBe("Website launch");
    expect(board.groups).toEqual(["To do", "In progress", "Done"]);
    expect(board.items.map((i) => [i.title, i.group === null ? null : board.groups[i.group]])).toEqual([
      ["Write the homepage copy", "To do"],
      ["Proofread the copy", "To do"],
      ["Design the mockups", "In progress"],
      ["Launch", "Done"],
      // A subtask without a section of its own is in its parent's.
      ["Write the press release", "Done"],
      ["Book the photographer", "To do"],
    ]);
  });

  it("reads completion, dates as one value, assignees with their address and tags", () => {
    const board = csv();
    expect(board.items.map((i) => i.done)).toEqual([false, false, true, false, false, false]);
    expect(task(board, "Write the homepage copy").dates).toBe("2026-10-01/2026-10-05");
    expect(task(board, "Proofread the copy").dates).toBe("2026-10-06");
    expect(task(board, "Write the press release").dates).toBeNull();
    expect(board.columns.slice(0, 2)).toEqual([
      { name: "Assignee", role: "assignee", type: "person" },
      { name: "Tags", role: "tags", type: "multi_select" },
    ]);
    expect(task(board, "Write the homepage copy").cells[0]).toEqual([{ name: "Ayşe Yılmaz", email: AYSE_EMAIL }]);
    expect(task(board, "Write the press release").cells[0]).toEqual([{ name: "Ayşe Yılmaz", email: null }]);
    expect(task(board, "Design the mockups").cells[0]).toBe("");
    expect(task(board, "Write the homepage copy").cells[1]).toEqual(["Content", "Marketing"]);
    expect(task(board, "Write the homepage copy").body).toContain("Draft the copy.");
  });

  it("types custom fields by their values", () => {
    const board = csv();
    expect(board.columns.slice(2).map((c) => `${c.name}:${c.type}`)).toEqual(["Priority:select", "Estimate:number", "Launch day:date", "Budget link:url"]);
    expect(board.columns[2].options?.map((o) => o.name)).toEqual(["High", "Low"]);
    expect(task(board, "Launch").cells.slice(2)).toEqual(["High", "8", "2026-11-02", ""]);
  });

  it("finds parents and dependencies by task id or by name, and counts what names no task", () => {
    const board = csv();
    expect(titleOf(board, task(board, "Write the press release").parent)).toBe("Launch");
    expect(task(board, "Book the photographer").parent).toBeNull();
    // Blocking 1202 on the copy is the proofreading blocked by it; both say so once.
    expect(task(board, "Proofread the copy").blockedBy.map((i) => titleOf(board, i))).toEqual(["Write the homepage copy"]);
    expect(task(board, "Launch").blockedBy.map((i) => titleOf(board, i))).toEqual(["Write the homepage copy", "Design the mockups"]);
    expect(board.unlinked).toEqual([
      { column: "Parent task", count: 1 },
      { column: "Blocked By (Dependencies)", count: 1 },
    ]);
  });

  it("lists the columns it leaves out", () => {
    // Projects: the launch is in Marketing too.
    expect(csv().leftOut).toEqual(["Created At", "Last Modified", "Projects"]);
  });

  it("leads links to tasks of the export to them", () => {
    expect(asanaTaskId("https://app.asana.com/0/1100/1203/f")).toBe("1203");
    expect(asanaTaskId("https://app.asana.com/0/1100/1203")).toBe("1203");
    expect(asanaTaskId("https://app.asana.com/1/77/project/2100/task/2202?focus=true")).toBe("2202");
    expect(asanaTaskId("https://app.asana.com/0/inbox/1")).toBeNull();
    expect(asanaTaskId("https://example.com/0/1/2")).toBeNull();
  });

  it("breaks dependency loops and parent loops a hand-made file has", () => {
    const text = [
      "Task ID,Name,Parent task,Blocked By (Dependencies)",
      "1,A,B,2",
      "2,B,A,1",
      "3,C,C,3",
    ].join("\n");
    const board = readAsanaExport("loops.csv", strToU8(text));
    // The loop is broken at the task that comes first, which becomes a top task.
    expect(board.items.map((i) => i.parent)).toEqual([null, 0, null]);
    expect(board.items.map((i) => i.blockedBy)).toEqual([[1], [], []]);
    expect(board.unlinked).toEqual([
      { column: "Parent task", count: 1 },
      { column: "Blocked By (Dependencies)", count: 1 },
    ]);
    expect(board.title).toBe("loops");
  });

  it("refuses other files and boards past the import's limits", () => {
    expect(() => readAsanaExport("x.csv", strToU8("Name,Points\nA,1\n"))).toThrow(expect.objectContaining({ code: "badAsana" }));
    expect(() => readAsanaExport("x.json", strToU8('{"pages": []}'))).toThrow(expect.objectContaining({ code: "badAsana" }));
    expect(() => readAsanaExport("x.json", strToU8("{ not json"))).toThrow(expect.objectContaining({ code: "badAsana" }));
    const many = ["Task ID,Name", ...Array.from({ length: 5001 }, (_, i) => `${i},T${i}`)].join("\n");
    expect(() => readAsanaExport("x.csv", strToU8(many))).toThrow(expect.objectContaining({ code: "tooManyRows" }));
    expect(csvTable(ASANA_CSV).rows).toHaveLength(6);
  });
});

describe("Asana JSON exports", () => {
  it("tells an export from other JSON", () => {
    expect(isAsanaJson(ASANA_JSON)).toBe(true);
    expect(isAsanaJson({ data: [{ name: "x" }] })).toBe(false);
    expect(isAsanaJson([ASANA_JSON])).toBe(false);
  });

  it("puts subtasks after their task, sections from the project's memberships", () => {
    const board = json();
    expect(board.title).toBe("Team offsite");
    expect(board.items.map((i) => i.title)).toEqual(["Plan the offsite", "Write the agenda", "Pick the dates"]);
    expect(board.groups).toEqual(["Planning", "Done"]);
    expect(board.items.map((i) => i.group)).toEqual([0, 0, 1]);
    expect(board.items.map((i) => i.parent)).toEqual([null, 0, null]);
    expect(board.items[1].blockedBy).toEqual([2]);
    expect(board.items.map((i) => i.done)).toEqual([false, true, true]);
  });

  it("keeps custom fields' types and colors, dates and times", () => {
    const board = json();
    expect(board.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["Assignee:person", "Tags:multi_select", "Priority:select", "Cost:number", "Decided:date"]);
    expect(board.columns[1].options).toEqual([{ name: "Events", color: "purple" }]);
    expect(board.columns[2].options).toEqual([
      { name: "High", color: "red" },
      { name: "Low", color: "green" },
    ]);
    expect(board.items[0].cells).toEqual([[{ name: "Ayşe Yılmaz", email: AYSE_EMAIL }], ["Events"], "High", "1250.5", "2026-09-30"]);
    expect(board.items[1].cells).toEqual([[{ name: "Bob Stone", email: null }], [], "Low", "", ""]);
    expect(board.items[0].dates).toBe("2026-10-12/2026-10-16");
    expect(board.items[1].dates).toBe("2026-10-01T15:00:00.000Z");
  });

  it("keeps comments oldest first and attachments as links", () => {
    const [offsite] = json().items;
    expect(offsite.comments).toEqual([
      { author: "Ayşe Yılmaz", date: "2026-09-02T09:15:00.000Z", text: "Which city?" },
      { author: "Bob Stone", date: "2026-09-05T12:00:00.000Z", text: "Booked the venue." },
    ]);
    expect(offsite.attachments).toEqual([{ name: "venue.pdf", url: "https://app.asana.com/app/asana/-/get_asset?asset_id=a1" }]);
    expect(json().leftOut).toEqual(["created_at", "modified_at"]);
  });
});
