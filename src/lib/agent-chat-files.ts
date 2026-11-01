// Client-safe: text files in the agent chat (lib/agent-chat.ts). The person attaches a few to a
// message (the box reads them in the browser, the Telegram bot downloads a document): their text
// goes to the answering run as data from outside (server/agents/run.ts), and the message keeps
// their names and sizes. The agent attaches files to its answer with `attach_file`, stored as
// uploads only the person opens (server/agents/chat-files.ts).

import { cleanAttachmentName, uniqueAttachmentName } from "./chat-attachments";
import type { AgentChatFileIn } from "./agent-chat";

/** What a message may attach: how many files, and how large each may be (bytes of UTF-8 text). */
export const AGENT_CHAT_FILE_LIMITS = { perMessage: 3, bytes: 100_000 };
/** What the agent may attach to one answer: how many files, and how large each may be. */
export const ANSWER_FILE_LIMITS = { perRun: 5, bytes: 200_000 };

const KINDS = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
} as const;
type Extension = keyof typeof KINDS;

/** What the file chooser offers. */
export const AGENT_CHAT_FILE_ACCEPT = Object.keys(KINDS)
  .map((e) => `.${e}`)
  .join(",");

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();

/**
 * The type of a text file the chat takes, by its name's extension (CSV, TSV, text, Markdown,
 * JSON), or by its type for a name without one; null for anything else.
 */
export function agentChatFileType(name: string, contentType = ""): string | null {
  const ext = extensionOf(name);
  if (ext) return ext in KINDS ? KINDS[ext as Extension] : null;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (Object.values(KINDS) as string[]).includes(type) ? type : null;
}

/** The size of a text in bytes, as UTF-8. */
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Why files can't be attached to a message. */
export type ChatFileProblem = "tooMany" | "tooLarge" | "type" | "binary";

/**
 * The files of a message as they are kept and sent: named apart from one another (and from
 * `taken`), each checked: one of the types above, text (no NUL characters), at most
 * AGENT_CHAT_FILE_LIMITS.bytes; at most AGENT_CHAT_FILE_LIMITS.perMessage of them.
 */
export function checkChatFiles(
  files: readonly { name: string; text: string }[],
  taken: readonly string[] = [],
): { ok: true; files: AgentChatFileIn[] } | { ok: false; problem: ChatFileProblem; name?: string } {
  if (files.length > AGENT_CHAT_FILE_LIMITS.perMessage) return { ok: false, problem: "tooMany" };
  const names = [...taken];
  const out: AgentChatFileIn[] = [];
  for (const f of files) {
    const name = cleanAttachmentName(f.name);
    if (!agentChatFileType(name, "text/plain")) return { ok: false, problem: "type", name };
    if (f.text.includes("\u0000")) return { ok: false, problem: "binary", name };
    const size = utf8Bytes(f.text);
    if (size > AGENT_CHAT_FILE_LIMITS.bytes) return { ok: false, problem: "tooLarge", name };
    const unique = uniqueAttachmentName(names, name);
    names.push(unique);
    out.push({ name: unique, size, text: f.text });
  }
  return { ok: true, files: out };
}

/**
 * A file the agent attaches (`attach_file`): its name as kept and its type, or why not. A name
 * without an extension becomes a text file.
 */
export function answerFile(name: string, content: string): { ok: true; name: string; contentType: string; size: number } | { ok: false; problem: "type" | "tooLarge" | "empty" } {
  let clean = cleanAttachmentName(name.replace(/[/\\]/g, " "));
  if (!extensionOf(clean)) clean = `${clean}.txt`;
  const contentType = agentChatFileType(clean);
  if (!contentType) return { ok: false, problem: "type" };
  if (!content.trim()) return { ok: false, problem: "empty" };
  const size = utf8Bytes(content);
  if (size > ANSWER_FILE_LIMITS.bytes) return { ok: false, problem: "tooLarge" };
  return { ok: true, name: clean, contentType, size };
}

/** Where the person opens a file the agent attached to its answer (no one else can). */
export const agentChatFileUrl = (id: string) => `/api/agents/chat/files/${id}`;
