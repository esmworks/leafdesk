/**
 * Small Evernote exports for the tests and the import e2e script (scripts/import-e2e.ts), written
 * the way Evernote writes them: the export's DOCTYPE, each note's content as an ENML document in
 * CDATA, attachments as base64 data.
 */

/** A 1×1 PNG. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type FixtureResource = { base64: string; mime: string; fileName?: string };

export type FixtureNote = {
  title: string;
  /** What goes inside `<en-note>`. */
  body: string;
  created?: string;
  updated?: string;
  tags?: string[];
  author?: string;
  sourceUrl?: string;
  resources?: FixtureResource[];
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A note's content as Evernote writes it: an ENML document with its DOCTYPE. */
export const enml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n<en-note>${body}</en-note>`;

function note(n: FixtureNote): string {
  const attributes = [n.author && `<author>${escape(n.author)}</author>`, n.sourceUrl && `<source-url>${escape(n.sourceUrl)}</source-url>`]
    .filter(Boolean)
    .join("");
  const resources = (n.resources ?? [])
    .map(
      (r) =>
        `<resource><data encoding="base64">\n${r.base64.replace(/(.{76})/g, "$1\n")}\n</data><mime>${r.mime}</mime><width>1</width><height>1</height>` +
        `<resource-attributes>${r.fileName ? `<file-name>${escape(r.fileName)}</file-name>` : ""}</resource-attributes></resource>`,
    )
    .join("");
  return (
    `<note><title>${escape(n.title)}</title><created>${n.created ?? "20231107T101530Z"}</created>` +
    (n.updated ? `<updated>${n.updated}</updated>` : "") +
    (n.tags ?? []).map((t) => `<tag>${escape(t)}</tag>`).join("") +
    `<note-attributes>${attributes}</note-attributes>` +
    `<content><![CDATA[${enml(n.body)}]]></content>${resources}</note>`
  );
}

/** An export of these notes. */
export function enexFile(notes: FixtureNote[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n` +
    `<en-export export-date="20231201T080000Z" application="Evernote" version="10.0">\n${notes.map(note).join("\n")}\n</en-export>\n`
  );
}
