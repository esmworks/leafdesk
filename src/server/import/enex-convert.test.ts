import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEnex } from "@/lib/import/enex";
import { enexFile, PNG_BASE64 } from "@/lib/import/enex-fixtures";
import { WarningList } from "@/lib/import/result";
import type { PageBlock } from "../blocknote";
import { mediaHashes, noteBlocks, placeMedia, resourceFiles, resourceName } from "./enex-convert";

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] };
const text = (block: PageBlock) =>
  Array.isArray(block.content) ? (block.content as Inline[]).map((i) => i.text ?? (i.content ?? []).map((c) => c.text).join("")).join("") : "";
const shape = (blocks: PageBlock[]): unknown[] =>
  blocks.map((b) => {
    const props = b.props as { level?: number; checked?: boolean; url?: string };
    const head = `${b.type}${props.level ?? ""}${props.checked === undefined ? "" : props.checked ? "[x]" : "[ ]"}${props.url ? ` ${props.url}` : ""}: ${text(b)}`;
    return b.children?.length ? [head, shape(b.children)] : head;
  });

const PNG_MD5 = createHash("md5").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
const PDF_BASE64 = Buffer.from("%PDF-1.4 tiny").toString("base64");
const PDF_MD5 = createHash("md5").update(Buffer.from(PDF_BASE64, "base64")).digest("hex");

const [note] = readEnex(
  "Notebook.enex",
  enexFile([
    {
      title: "Weekend",
      body:
        `<h1>Plan</h1><div>Pack <b>light</b></div><div><en-todo checked="true"/>Tickets</div><div><en-todo/>Snacks</div>` +
        `<ul><li><div>Day one</div><ul><li><div>Museum</div></li></ul></li></ul>` +
        `<table><tr><td>Hotel</td><td>2 nights</td></tr></table>` +
        `<div style="-en-codeblock:true;"><div>ssh host</div></div>` +
        `<div><en-media hash="${PNG_MD5}" type="image/png"/></div><en-media hash="${PDF_MD5}" type="application/pdf"/>` +
        `<en-media hash="ffffffffffffffffffffffffffffffff" type="image/png"/><en-crypt>abc</en-crypt>`,
      resources: [
        { base64: PNG_BASE64, mime: "image/png" },
        { base64: PDF_BASE64, mime: "application/pdf", fileName: "tickets/booking.pdf" },
        { base64: PNG_BASE64, mime: "image/png" },
      ],
    },
  ]),
);

describe("a note's blocks", () => {
  it("are its content as the editor's blocks, the title heading kept", async () => {
    const warnings = new WarningList();
    const blocks = (await noteBlocks("Notebook.enex/Weekend", note, "Encrypted text was left out.", warnings))!;
    expect(shape(blocks)).toEqual([
      "heading1: Plan",
      "paragraph: Pack light",
      "checkListItem[x]: Tickets",
      "checkListItem[ ]: Snacks",
      ["bulletListItem: Day one", ["bulletListItem: Museum"]],
      "table: ",
      "codeBlock: ssh host",
      `image /leafdesk-enex-media/${PNG_MD5}: `,
      `image /leafdesk-enex-media/${PDF_MD5}: `,
      "image /leafdesk-enex-media/ffffffffffffffffffffffffffffffff: ",
      "paragraph: Encrypted text was left out.",
    ]);
    expect(warnings.list).toEqual([{ code: "encryptedText", page: "Notebook.enex/Weekend" }]);
    expect(mediaHashes(blocks)).toEqual([PNG_MD5, PDF_MD5, "ffffffffffffffffffffffffffffffff"]);
  });

  it("are left out with a warning when the content isn't well-formed", async () => {
    const warnings = new WarningList();
    const [broken] = readEnex("N.enex", enexFile([{ title: "Broken", body: "<div><b>x</div>" }]));
    expect(await noteBlocks("N.enex/Broken", broken, "", warnings)).toBeNull();
    expect(warnings.list).toEqual([{ code: "skipped", path: "N.enex/Broken", reason: "badNote" }]);
  });
});

describe("attachments", () => {
  it("are found by the MD5 hash of their bytes, once each, with names", () => {
    const files = resourceFiles(note);
    expect([...files.keys()]).toEqual([PNG_MD5, PDF_MD5]);
    expect(files.get(PNG_MD5)).toMatchObject({ name: "image-1.png", mime: "image/png" });
    expect(files.get(PDF_MD5)).toMatchObject({ name: "tickets_booking.pdf", mime: "application/pdf" });
    expect(resourceName({ data: "", mime: "application/octet-stream", fileName: null }, 3)).toBe("attachment-3");
  });

  it("show as images or files once uploaded, and are dropped when they weren't", async () => {
    const blocks = (await noteBlocks("p", note, "", new WarningList()))!;
    const placed = placeMedia(
      blocks,
      new Map([
        [PNG_MD5, { type: "image" as const, url: "/api/files/a", name: "image-1.png" }],
        [PDF_MD5, { type: "file" as const, url: "/api/files/b", name: "booking.pdf" }],
      ]),
    );
    const media = placed.filter((b) => b.type === "image" || b.type === "file");
    expect(media.map((b) => [b.type, (b.props as { url: string; name: string }).url, (b.props as { name: string }).name])).toEqual([
      ["image", "/api/files/a", "image-1.png"],
      ["file", "/api/files/b", "booking.pdf"],
    ]);
    expect(placed).toHaveLength(blocks.length - 1);
  });
});
