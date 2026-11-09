import { describe, expect, it } from "vitest";
import { fast } from "./linear-fixtures";
import { jexFolder, readItem, rewriteItemLinks, unpackJoplinExports } from "./joplin";

const id = (n: number) => n.toString(16).padStart(32, "0");
const item = (title: string, body: string | null, props: Record<string, string | number>) =>
  [title, ...(body === null ? [] : [body]), Object.entries(props).map(([k, v]) => `${k}: ${v}`).join("\n")].join("\n\n");

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : undefined);

/** An export unpacked as server/import/archive leaves it: `<dir>Notes.jex/<entry>`. */
function exported(entries: Record<string, string | Uint8Array>, dir = "") {
  return new Map(Object.entries(entries).map(([name, content]) => [`${dir}Notes.jex/${name}`, typeof content === "string" ? encode(content) : content]));
}

describe("readItem", () => {
  it("reads the title, body and properties, the way Joplin reads them back", () => {
    const read = readItem(item("Plan", "# Week\n\nShip it.\n\nkey: not a property", { id: id(1), parent_id: id(2), type_: 1 }));
    expect(read?.title).toBe("Plan");
    expect(read?.body).toBe("# Week\n\nShip it.\n\nkey: not a property");
    expect(read?.props.get("parent_id")).toBe(id(2));
  });

  it("reads an item without a body, and refuses text without an id and type", () => {
    expect(readItem(item("Work", null, { id: id(2), type_: 2 }))).toMatchObject({ title: "Work", body: "" });
    expect(readItem("Just a note\n\nwith text")).toBeNull();
    expect(readItem("")).toBeNull();
  });
});

describe("rewriteItemLinks", () => {
  it("points `:/id` links of the export at their files, in Markdown and HTML", () => {
    const body = `[Other](:/${id(3)}) ![pic](:/${id(4)}) <img src=":/${id(4)}" width="40"> [gone](:/${id(9)}) http://x/:/${"a".repeat(40)}`;
    const out = rewriteItemLinks(body, (target) => ({ [id(3)]: "Other.md", [id(4)]: "_resources/x/pic.png" })[target] ?? null);
    expect(out).toBe(`[Other](Other.md) ![pic](_resources/x/pic.png) <img src="_resources/x/pic.png" width="40"> [gone](:/${id(9)}) http://x/:/${"a".repeat(40)}`);
  });

  it("takes time growing with the text's length", () => {
    fast(() => rewriteItemLinks(":/".repeat(400_000), () => "x"));
    fast(() => rewriteItemLinks(`:/${"0".repeat(31)}`.repeat(30_000), () => "x"));
  });
});

describe("jexFolder", () => {
  it("finds the export's folder of a file in it", () => {
    expect(jexFolder("Backups/Notes.jex/abc.md")).toBe("Backups/Notes.jex");
    expect(jexFolder("Notes.jex")).toBeNull();
    expect(jexFolder("Notes/abc.md")).toBeNull();
  });
});

describe("unpackJoplinExports", () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const entries = {
    [`${id(1)}.md`]: item("Work", null, { id: id(1), parent_id: "", type_: 2 }),
    [`${id(2)}.md`]: item("Projects", null, { id: id(2), parent_id: id(1), type_: 2 }),
    [`${id(3)}.md`]: item("Launch / plan", `See [the list](:/${id(4)}) and ![diagram](:/${id(5)}).`, { id: id(3), parent_id: id(2), is_todo: 0, type_: 1 }),
    [`${id(4)}.md`]: item("List", "- milk", { id: id(4), parent_id: id(1), is_todo: 1, todo_completed: 0, todo_due: Date.UTC(2026, 10, 20), type_: 1 }),
    [`${id(5)}.md`]: item("diagram.png", null, { id: id(5), mime: "image/png", filename: "", file_extension: "png", type_: 4 }),
    [`resources/${id(5)}.png`]: png,
    [`${id(6)}.md`]: item("Old", "trashed", { id: id(6), parent_id: id(1), deleted_time: 1700000000000, type_: 1 }),
    [`${id(7)}.md`]: item("", "", { id: id(7), encryption_applied: 1, encryption_cipher_text: "xyz", type_: 1 }),
    [`${id(8)}.md`]: item("Done thing", "", { id: id(8), parent_id: "", is_todo: 1, todo_completed: 1700000000000, type_: 1 }),
    [`${id(10)}.md`]: item("road map", null, { id: id(10), type_: 5 }),
    [`${id(11)}.md`]: item("", null, { id: id(11), note_id: id(3), tag_id: id(10), type_: 6 }),
    [`${id(12)}.md`]: item("Work", "a note named like its notebook", { id: id(12), parent_id: "", type_: 1 }),
  };

  it("lays out notebooks as folders of notes, with resources, links, to-dos and tags", () => {
    const { files, exports, encrypted } = unpackJoplinExports(exported(entries, "In/"));
    expect(exports).toBe(1);
    expect(encrypted).toEqual([{ export: "Notes.jex", count: 1 }]);
    expect([...files.keys()].sort()).toEqual([
      "In/Done thing.md",
      "In/Work (2).md",
      "In/Work/List.md",
      "In/Work/Projects/Launch - plan.md",
      `In/_resources/${id(5)}/diagram.png`,
    ]);
    expect(decode(files.get("In/Work/Projects/Launch - plan.md"))).toBe(
      `---\ntitle: "Launch / plan"\n---\n\nSee [the list](../List.md) and ![diagram](../../_resources/${id(5)}/diagram.png).\n\n#road-map\n`,
    );
    expect(decode(files.get("In/Work/List.md"))).toBe(`---\ntitle: "List"\n---\n\n- [ ] List @2026-11-20\n\n- milk`);
    expect(decode(files.get("In/Done thing.md"))).toContain("- [x] Done thing\n");
    expect(files.get(`In/_resources/${id(5)}/diagram.png`)).toBe(png);
  });

  it("leaves other files alone, and an upload without exports as it was", () => {
    const plain = new Map([["Notes/a.md", encode("a")]]);
    expect(unpackJoplinExports(plain).files).toBe(plain);
    const { files } = unpackJoplinExports(new Map([...plain, ...exported(entries)]));
    expect(files.has("Notes/a.md")).toBe(true);
    expect(files.has("Work/List.md")).toBe(true);
  });

  it("writes a to-do's due day in the importing person's time zone", () => {
    const todo = { [`${id(1)}.md`]: item("Call", "", { id: id(1), is_todo: 1, todo_completed: 0, todo_due: Date.UTC(2026, 10, 20, 2), type_: 1 }) };
    expect(decode(unpackJoplinExports(exported(todo)).files.get("Call.md"))).toContain("@2026-11-20");
    expect(decode(unpackJoplinExports(exported(todo), "America/New_York").files.get("Call.md"))).toContain("@2026-11-19");
  });

  it("names a note without a title by its first line", () => {
    const { files } = unpackJoplinExports(exported({ [`${id(1)}.md`]: item("", "## Groceries for the week\n\neggs", { id: id(1), type_: 1 }) }));
    expect([...files.keys()]).toEqual(["Groceries for the week.md"]);
  });

  it("puts a notebook whose parents loop at the top", () => {
    const { files } = unpackJoplinExports(
      exported({
        [`${id(1)}.md`]: item("A", null, { id: id(1), parent_id: id(2), type_: 2 }),
        [`${id(2)}.md`]: item("B", null, { id: id(2), parent_id: id(1), type_: 2 }),
        [`${id(3)}.md`]: item("Note", "x", { id: id(3), parent_id: id(1), type_: 1 }),
      }),
    );
    expect([...files.keys()]).toHaveLength(1);
    expect([...files.keys()][0]).toMatch(/\/Note\.md$/);
  });
});
