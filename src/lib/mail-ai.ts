/**
 * The Mail tab's AI (server/mail-client/ai.ts): what the composer's writer can be asked to do, and
 * its answer turned into the editor's HTML. Small and import-free: the composer loads it.
 */

/**
 * What the writer does: `reply` writes an answer to the message being answered (from the draft's
 * notes, if any), `custom` follows the person's instruction, the rest rework the draft.
 */
export const MAIL_WRITE_ACTIONS = ["reply", "improve", "shorten", "fix", "formal", "friendly", "translate", "custom"] as const;
export type MailWriteAction = (typeof MAIL_WRITE_ACTIONS)[number];

/** Actions that rework what is written, so there must be something. */
export const DRAFT_ACTIONS: readonly MailWriteAction[] = ["improve", "shorten", "fix", "formal", "friendly", "translate"];

export const MAX_MAIL_INSTRUCTION = 1_000;
/** The messages of a thread a summary reads, newest first. */
export const SUMMARY_MESSAGES = 8;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A line's text, escaped, with `**bold**` made bold: the one mark the writer is asked for. */
const inline = (line: string) => escape(line).replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+/;

/**
 * The writer's plain-text answer as the composer's HTML, written the way typing writes it there
 * (its paragraphs have no space around them): a paragraph per line, an empty one per blank line,
 * lines starting "- " or "1. " as lists, `**bold**` bold. Everything else is text: nothing the model
 * writes becomes markup of its own.
 */
export function draftHtml(text: string): string {
  const out: string[] = [];
  const blocks = text
    .replace(/\r\n/g, "\n")
    .replace(/^```[^\n]*\n|\n```\s*$/g, "")
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim());
    if (!lines.length) continue;
    if (out.length) out.push("<p></p>");
    let i = 0;
    while (i < lines.length) {
      const list = BULLET.test(lines[i]) ? BULLET : NUMBERED.test(lines[i]) ? NUMBERED : null;
      if (!list) {
        out.push(`<p>${inline(lines[i++].trim())}</p>`);
        continue;
      }
      const items: string[] = [];
      while (i < lines.length && list.test(lines[i])) items.push(`<li><p>${inline(lines[i++].replace(list, "").trim())}</p></li>`);
      out.push(list === BULLET ? `<ul>${items.join("")}</ul>` : `<ol>${items.join("")}</ol>`);
    }
  }
  return out.join("");
}
