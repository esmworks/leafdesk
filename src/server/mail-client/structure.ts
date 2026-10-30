import type { ImapFlow, MessageStructureObject } from "imapflow";
import type { MailAttachmentView } from "@/lib/mail-client";

/**
 * What a message is made of, from its BODYSTRUCTURE: the part to read as text, the one to read as
 * HTML, and the files. Only these parts are downloaded when the message is opened, so a large
 * attachment is never fetched unless someone asks for it. Each keeps its transfer encoding and
 * charset from the structure: parts are fetched raw and decoded here (readPart), as servers don't
 * all answer a part's own MIME header right (GreenMail gives a nested part its parent's).
 */
export type PartRef = { part: string; size: number; encoding: string; charset: string | null };
export type FilePart = MailAttachmentView & { encoding: string };
export type MessageParts = { text: PartRef | null; html: PartRef | null; attachments: FilePart[] };

/** IMAP numbers a message that is no multipart "1" at its root (BODYSTRUCTURE gives it no number). */
const partOf = (node: MessageStructureObject) => node.part ?? "1";

function fileName(node: MessageStructureObject) {
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export function messageParts(root: MessageStructureObject | undefined): MessageParts {
  const out: MessageParts = { text: null, html: null, attachments: [] };
  if (!root) return out;

  function visit(node: MessageStructureObject, alternative: boolean) {
    const type = (node.type ?? "").toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of node.childNodes ?? []) visit(child, type === "multipart/alternative" || alternative);
      return;
    }
    const disposition = (node.disposition ?? "").toLowerCase();
    const name = fileName(node);
    const contentId = node.id ? node.id.replace(/^<|>$/g, "") : null;
    const encoding = (node.encoding ?? "7bit").toLowerCase();
    const isText = type === "text/plain" || type === "text/html";
    // A text part is the body unless it is a file of its own; the first of each kind counts.
    if (isText && disposition !== "attachment" && !(name && disposition)) {
      const slot = type === "text/plain" ? "text" : "html";
      if (!out[slot]) {
        out[slot] = { part: partOf(node), size: node.size ?? 0, encoding, charset: node.parameters?.charset?.toLowerCase() ?? null };
        return;
      }
      if (alternative) return;
    }
    const inline = !!contentId && disposition !== "attachment" && type.startsWith("image/");
    out.attachments.push({
      part: partOf(node),
      name: name ?? (type === "message/rfc822" ? `${node.envelope?.subject?.trim() || "message"}.eml` : "attachment"),
      contentType: type || "application/octet-stream",
      size: node.size ?? 0,
      contentId,
      inline,
      encoding,
    });
  }

  visit(root, false);
  return out;
}

/** Whether a message brings files someone would want to see (not only the images its HTML shows). */
export const hasFiles = (parts: MessageParts) => parts.attachments.some((a) => !a.inline);

/** A file as the Mail tab lists it, without how it travels. */
export const fileView = ({ encoding: _encoding, ...file }: FilePart): MailAttachmentView => file;

function quotedPrintable(raw: Buffer) {
  const text = raw.toString("latin1").replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** A part's bytes without its transfer encoding. */
export function decodeTransfer(raw: Buffer, encoding: string) {
  if (encoding === "base64") return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/]/g, ""), "base64");
  if (encoding === "quoted-printable") return quotedPrintable(raw);
  return raw;
}

/** A text part's characters, from its charset (UTF-8 when it names none the runtime knows). */
export function decodeText(raw: Buffer, encoding: string, charset: string | null) {
  const bytes = decodeTransfer(raw, encoding);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/**
 * A part of a message as it travels (at most `limit` bytes of it), for decodeText or
 * decodeTransfer; null when the server has no such part. In the folder already open.
 */
export async function readPart(client: ImapFlow, uid: number, part: string, limit: number): Promise<Buffer | null> {
  const fetched = await client.fetchOne(String(uid), { uid: true, bodyParts: [{ key: part, maxLength: limit }] }, { uid: true });
  return (fetched && (fetched.bodyParts?.get(part) ?? fetched.bodyParts?.get(part.toLowerCase()))) || null;
}
