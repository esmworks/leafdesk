import { strToU8, unzipSync, zipSync } from "fflate";
import { toXlsx, type XlsxValue } from "../xlsx";

/*
 * Exports for the Asana and Monday.com importers' tests (lib/import/asana.test, monday.test and
 * scripts/import-e2e), built from the apps' documented export formats rather than taken from real
 * exports. The workspace in the end-to-end check has a member named Ayşe Yılmaz whose address
 * replaces AYSE_EMAIL.
 */

export const AYSE_EMAIL = "ayse@example.test";

/** An Asana project's *Export → CSV*: tasks, a subtask, dependencies both ways, custom fields. */
export const ASANA_CSV = [
  "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task,Blocked By (Dependencies),Blocking (Dependencies),Priority,Estimate,Launch day,Budget link",
  `1201,2026-09-01,,2026-09-10,Write the homepage copy,To do,Ayşe Yılmaz,${AYSE_EMAIL},2026-10-01,2026-10-05,"Content, Marketing","Draft the copy.\nThe mockups are in https://app.asana.com/0/1100/1203/f",Website launch,,,1202,High,3,2026-11-02,https://docs.example.com/copy`,
  "1202,2026-09-01,,2026-09-10,Proofread the copy,To do,Bob Stone,bob@elsewhere.test,,2026-10-06,Content,,Website launch,,1201,,Low,1,,",
  "1203,2026-09-02,2026-09-20,2026-09-20,Design the mockups,In progress,,,,2026-10-03,Design,Desktop and mobile.,Website launch,,,,High,5,,",
  `1204,2026-09-03,,2026-09-21,Launch,Done,Ayşe Yılmaz,${AYSE_EMAIL},,2026-11-02,,,"Website launch, Marketing",,"1201, 1203, 9999",,High,8,2026-11-02,`,
  "1205,2026-09-04,,2026-09-21,Write the press release,,Ayşe Yılmaz,,,,,Mention the new pricing.,Website launch,Launch,,,,,,",
  "1206,2026-09-04,,2026-09-21,Book the photographer,To do,,,,,,,Website launch,Someone else's task,,,,,,",
].join("\n");

/** An Asana project's *Export → JSON*: tasks with nested subtasks, typed custom fields, comments and attachments. */
export const ASANA_JSON = {
  data: [
    {
      gid: "2201",
      resource_type: "task",
      name: "Plan the offsite",
      notes: "Venue and travel. Agenda: https://app.asana.com/1/1/project/2100/task/2202",
      completed: false,
      created_at: "2026-09-01T08:00:00.000Z",
      modified_at: "2026-09-10T08:00:00.000Z",
      start_on: "2026-10-12",
      due_on: "2026-10-16",
      assignee: { gid: "9001", name: "Ayşe Yılmaz", email: AYSE_EMAIL },
      tags: [{ gid: "t1", name: "Events", color: "dark-purple" }],
      projects: [{ gid: "2100", name: "Team offsite" }],
      memberships: [{ project: { gid: "2100", name: "Team offsite" }, section: { gid: "s1", name: "Planning" } }],
      parent: null,
      custom_fields: [
        {
          gid: "f1",
          name: "Priority",
          resource_subtype: "enum",
          enum_options: [
            { gid: "o1", name: "High", color: "dark-red", enabled: true },
            { gid: "o2", name: "Low", color: "light-green", enabled: true },
          ],
          enum_value: { gid: "o1", name: "High", color: "dark-red" },
        },
        { gid: "f2", name: "Cost", resource_subtype: "number", number_value: 1250.5 },
        { gid: "f3", name: "Decided", resource_subtype: "date", date_value: { date: "2026-09-30", date_time: null } },
      ],
      stories: [
        { gid: "c2", resource_subtype: "comment_added", text: "Booked the venue.", created_at: "2026-09-05T12:00:00.000Z", created_by: { name: "Bob Stone" } },
        { gid: "c1", resource_subtype: "comment_added", text: "Which city?", created_at: "2026-09-02T09:15:00.000Z", created_by: { name: "Ayşe Yılmaz" } },
        { gid: "c3", resource_subtype: "assigned", text: "assigned to Ayşe", created_at: "2026-09-02T09:00:00.000Z", created_by: { name: "Bob Stone" } },
      ],
      attachments: [{ gid: "a1", name: "venue.pdf", permanent_url: "https://app.asana.com/app/asana/-/get_asset?asset_id=a1" }],
      subtasks: [
        {
          gid: "2202",
          name: "Write the agenda",
          notes: "",
          completed: true,
          due_at: "2026-10-01T15:00:00.000Z",
          assignee: { gid: "9002", name: "Bob Stone" },
          tags: [],
          custom_fields: [{ gid: "f1", name: "Priority", resource_subtype: "enum", enum_value: { gid: "o2", name: "Low", color: "light-green" } }],
          dependencies: [{ gid: "2203" }],
        },
      ],
    },
    {
      gid: "2203",
      resource_type: "task",
      name: "Pick the dates",
      notes: "",
      completed: true,
      due_on: "2026-09-25",
      assignee: null,
      tags: [],
      projects: [{ gid: "2100", name: "Team offsite" }],
      memberships: [{ project: { gid: "2100", name: "Team offsite" }, section: { gid: "s2", name: "Done" } }],
      custom_fields: [{ gid: "f2", name: "Cost", resource_subtype: "number", number_value: null }],
    },
  ],
};

/** Monday's *Export board to Excel*: the board, its updates and a sheet of something else. */
export const MONDAY_BOARD: XlsxValue[][] = [
  ["Marketing board"],
  ["This week"],
  ["Name", "Subitems", "Owner", "Status", "Due date", "Timeline", "Budget", "Tags", "Brief", "Contact", "Phone", "Approved", "Notes", "Dependency", "Location", "Item ID"],
  [
    "Launch campaign",
    "Write brief, Book ads",
    "Ayşe Yılmaz",
    "Working on it",
    { date: "2026-10-20" },
    "2026-10-01 - 2026-10-15",
    1200,
    "Social, Paid",
    "Brief - https://docs.example.com/brief",
    AYSE_EMAIL,
    "+90 555 111 2233",
    "v",
    "Plan first: https://acme.monday.com/boards/123/pulses/1002",
    "Plan event",
    "Galata Tower, Istanbul (41.0256, 28.9741)",
    1001,
  ],
  [null, "Subitems", "Owner", "Status", "Date"],
  [null, "Write brief", "Bob Stone", "Done", { date: "2026-10-05" }],
  [null, "Book ads", null, "Stuck", null],
  ["Plan event", null, "Bob Stone, Ayşe Yılmaz", "Done", { date: "2026-10-10" }, null, 300, "Social", null, null, null, null, null, null, "41.0082, 28.9784", 1002],
  [],
  ["Next week"],
  ["Name", "Subitems", "Owner", "Status", "Due date", "Timeline", "Budget", "Tags", "Brief", "Contact", "Phone", "Approved", "Notes", "Dependency", "Location", "Item ID"],
  ["Retro", "Collect feedback", null, null, null, null, null, null, null, null, null, null, null, "Nothing like it", null, 1003],
  ["Newsletter"],
];

export const MONDAY_UPDATES: XlsxValue[][] = [
  ["Item ID", "Item Name", "User", "Created At", "Update Content"],
  [1001, "Launch campaign", "Ayşe Yılmaz", "2026-10-02 09:30:00", "The brief is ready."],
  [1001, "Launch campaign", "Bob Stone", "2026-10-01 08:00:00", "Kickoff on Monday, see https://acme.monday.com/boards/123/pulses/1002"],
  [null, "Gone item", "Bob Stone", "2026-10-03 10:00:00", "On an item that isn't on the board."],
];

/** A workbook of several sheets, each written by lib/xlsx (which writes one). */
export function workbookOf(sheets: { name: string; rows: XlsxValue[][] }[]): Uint8Array {
  const parts = sheets.map((s) => unzipSync(toXlsx(s.rows, { name: s.name })));
  const files: Record<string, Uint8Array> = { ...parts[0] };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  sheets.forEach((_, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = parts[i]["xl/worksheets/sheet1.xml"]));
  const sheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
  files["[Content_Types].xml"] = strToU8(
    text(parts[0]["[Content_Types].xml"]).replace(
      "</Types>",
      sheets.slice(1).map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 2}.xml" ContentType="${sheetType}"/>`).join("") + "</Types>",
    ),
  );
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    text(parts[0]["xl/_rels/workbook.xml.rels"]).replace(
      "</Relationships>",
      sheets.slice(1).map((_, i) => `<Relationship Id="rIdS${i + 2}" Type="${rel}" Target="worksheets/sheet${i + 2}.xml"/>`).join("") + "</Relationships>",
    ),
  );
  files["xl/workbook.xml"] = strToU8(
    text(parts[0]["xl/workbook.xml"]).replace(
      "</sheets>",
      sheets.slice(1).map((s, i) => `<sheet name="${s.name}" sheetId="${i + 2}" r:id="rIdS${i + 2}"/>`).join("") + "</sheets>",
    ),
  );
  return zipSync(files);
}

/** The board exported with its updates. */
export const mondayWorkbook = () =>
  workbookOf([
    { name: "Marketing board", rows: MONDAY_BOARD },
    { name: "Updates", rows: MONDAY_UPDATES },
    { name: "Chart data", rows: [["Status", "Count"], ["Done", 2]] },
  ]);
