/**
 * Google Docs brought in through a workspace's Google Drive connection (an outbound MCP
 * connection, see server/connections): the Drive server finds documents with `search_files` and
 * exports each as a Word document with `download_file_content`, which the Word import then reads
 * (server/import/google-docs.ts). This part is shared by the import dialog and the server.
 */

/** The Drive connection's tools the import uses. */
export const DRIVE_SEARCH_TOOL = "search_files";
export const DRIVE_DOWNLOAD_TOOL = "download_file_content";

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Documents one import takes: each is a call to Google, one after another. */
export const MAX_GOOGLE_DOCS = 20;
/** Documents a search shows. */
export const GOOGLE_DOCS_PAGE = 25;
export const MAX_GOOGLE_DOCS_SEARCH = 200;

/** A Google document as a search lists it. */
export type GoogleDoc = { id: string; title: string; modifiedTime: string | null; owner: string | null };

/** A connection the person may import through, as the dialog shows it (never its secrets). */
export type GoogleDocsSource = { id: string; name: string; icon: string | null; search: boolean };

const ID = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * The document id in a Google Docs or Drive link (`/document/d/<id>`, `/file/d/<id>`, `?id=<id>`),
 * or `text` itself when it looks like an id; null for anything else.
 */
export function googleDocId(text: string): string | null {
  const value = text.trim();
  if (ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/(^|\.)google\.com$/i.test(url.hostname)) return null;
  const inPath = /\/(?:document|file)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  const id = inPath ?? url.searchParams.get("id");
  return id && ID.test(id) ? id : null;
}

/** The document ids in pasted text (links or ids, one per line or separated by spaces), and what wasn't one. */
export function googleDocIds(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    const id = googleDocId(part);
    if (!id) invalid.push(part);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

/** The Drive search for Google documents whose title has `words` (all of them), newest first as Drive lists them. */
export function googleDocsQuery(words: string): string {
  const quoted = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const clauses = [`mimeType = ${quoted(GOOGLE_DOC_MIME)}`];
  for (const word of words.trim().split(/\s+/).filter(Boolean).slice(0, 10)) clauses.push(`title contains ${quoted(word.slice(0, 100))}`);
  return clauses.join(" and ");
}

/** A tool's answer, the parts the import reads. */
export type ToolAnswer = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

/** The JSON object a tool answered with: its structured content, else the first text part that is one. */
export function answerJson(answer: ToolAnswer): Record<string, unknown> | null {
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (isObject(answer.structuredContent)) return answer.structuredContent;
  for (const part of answer.content ?? []) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(part.text);
      if (isObject(parsed)) return parsed;
    } catch {}
  }
  return null;
}

/** The text of a tool's answer, for its error. */
export const answerText = (answer: ToolAnswer) =>
  (answer.content ?? [])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

/** The Google documents in a search's answer (other files left out), and the next page's token. */
export function readDocList(json: Record<string, unknown> | null): { docs: GoogleDoc[]; next: string | null } {
  const files = Array.isArray(json?.files) ? json.files : [];
  const docs: GoogleDoc[] = [];
  for (const file of files as Record<string, unknown>[]) {
    const id = text(file?.id, 200);
    if (!id || !ID.test(id) || (file.mimeType !== undefined && file.mimeType !== GOOGLE_DOC_MIME)) continue;
    if (docs.some((d) => d.id === id)) continue;
    docs.push({
      id,
      title: text(file.title ?? file.name, 200)?.trim() ?? "",
      modifiedTime: text(file.modifiedTime, 40),
      owner: text(file.owner, 200),
    });
  }
  return { docs, next: text(json?.nextPageToken, 4_000) || null };
}

/** The exported document in a download's answer: its base64 content and title; null when it has none. */
export function readExport(json: Record<string, unknown> | null): { content: string; title: string | null } | null {
  const content = typeof json?.content === "string" ? json.content.replace(/\s+/g, "") : "";
  if (!content) return null;
  return { content, title: text(json?.title ?? json?.name, 200)?.trim() || null };
}

/** Bytes that base64 text decodes to (without decoding it). */
export function base64Bytes(content: string) {
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return Math.floor((content.length * 3) / 4) - padding;
}

/** What a person may do through a connection: import (download) and search, given their role. */
export function googleDocsAccess(
  row: { status: string; tools: { name: string }[]; chatTools: string[] },
  role: "owner" | "member" | "guest",
): { download: boolean; search: boolean } {
  const has = (name: string) => row.status === "ready" && row.tools.some((t) => t.name === name);
  // Owners manage the connection; members read through it only what an owner lets their AI chat read.
  const may = (name: string) => has(name) && (role === "owner" || (role === "member" && row.chatTools.includes(name)));
  const download = may(DRIVE_DOWNLOAD_TOOL);
  return { download, search: download && may(DRIVE_SEARCH_TOOL) };
}
