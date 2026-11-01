/**
 * The AI chat on the person's own mail, where they may use the Mail tab in the workspace
 * (mail-client/read.ts mailTabShown): `search_mail`, `read_mail` and `read_mail_attachment` (a
 * message's file, mail-client/ai-files.ts) read it as the tab does (never marking anything seen),
 * `draft_mail` saves a draft in their Drafts folder. Nothing here sends mail: the person sends a
 * draft from the Mail tab.
 *
 * Mail and its files are anyone's words. What the tools read comes back framed as data from outside, and once an
 * answer read mail, ai-chat.ts asks the person before every change and note for the rest of it,
 * even in Auto. A draft could carry what the model read to an address an email named: each is
 * asked about in every mode, showing its sender, every recipient, the subject and the text, and
 * "don't ask again" isn't offered. Only the person's own chat in the app has these tools: not
 * research, the Telegram bot (a connected app), MCP or use_tool (mail-client/access.ts).
 *
 * An agent's run gets them only for the mailboxes its person opened to it (agents/mail.ts), held to
 * those (`boxes`). No one is asked about its drafts, so who they go to is checked here instead: a
 * reply only to the people of its thread, a new email only to addresses the person wrote in their
 * message or task (`typed`) or the mailbox's own.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { db } from "@/db";
import { mailbox, mailFolder, mailMessage } from "@/db/schema";
import type { MailSortAction } from "@/db/schema/ai";
import type { ChatActionView } from "@/lib/ai-chat";
import { env } from "@/lib/env";
import { formatBytes } from "@/lib/files";
import { normalizeAddress } from "@/lib/mail";
import { draftHtml } from "@/lib/mail-ai";
import { mailFileKind } from "@/lib/mail-ai-files";
import { ALL_INBOXES, movableTo, type MailAgentDeed, type MailAgentMark, type MailThreadItem } from "@/lib/mail-client";
import { AccessError } from "@/server/access";
import { AiError, type AiTool } from "@/server/ai";
import { externalData } from "@/server/ai/frame";
import { formatSources } from "@/server/ai/prompts";
import { registerWeb, unknownArguments, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { connectedAppCall } from "@/server/connected-app";
import { loadMessages } from "@/i18n/messages";
import { recipientLocale } from "@/server/mail/locale";
import { MailConnectError } from "@/server/row-mail/connect";
import { RowMailError } from "@/server/row-mail/settings";
import { saveSummary, threadForAi, type AiMailFiles } from "@/server/mail-client/ai";
import { mailFileForAi } from "@/server/mail-client/ai-files";
import { conversationText } from "@/server/mail-client/ai-prompts";
import { saveDraft } from "@/server/mail-client/drafts";
import { outgoingBody } from "@/server/mail-client/outgoing";
import { listMailboxes, listThreads, mailTabShown, openMailbox, ownMessage } from "@/server/mail-client/read";
import { mailAction } from "@/server/mail-client/write";

export const MAIL_TOOL_NAMES = { search: "search_mail", read: "read_mail", attachment: "read_mail_attachment", draft: "draft_mail" } as const;

/** Threads a search lists, a thread's text read, a file's text read at once, and a draft's recipients and text, at most. */
const SEARCH_THREADS = 15;
const THREAD_CHARS = 20_000;
const FILE_CHARS = 30_000;
const MAX_DRAFT_RECIPIENTS = 20;
const DRAFT_CHARS = 20_000;
const SUBJECT_CHARS = 300;
/** How long a search waits for the first read of a mailbox the Mail tab never opened. */
const FIRST_READ_MS = 15_000;

const READ_TOOLS: AiTool[] = [
  {
    name: MAIL_TOOL_NAMES.search,
    description:
      "Searches the person's own email: all their mailboxes in this workspace, every folder but the trash and junk, newest first. Words match senders, recipients, subjects and the text of the messages. Returns threads, each with a message_id to read it with read_mail.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'A few distinctive words or names, and these if they help: from:, to:, subject:, has:attachment, is:unread, after:YYYY-MM-DD, before:YYYY-MM-DD (a value with spaces in quotes: subject:"price offer").',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: MAIL_TOOL_NAMES.read,
    description:
      "Reads an email thread by a message_id from search_mail: its last messages, oldest first, as a numbered source to cite, the files of those messages (read one with read_mail_attachment), and the database row its other party is, when there is one (read it with read_page). Doesn't mark the mail as read.",
    parameters: {
      type: "object",
      properties: { message_id: { type: "string", description: "A message_id from search_mail." } },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: MAIL_TOOL_NAMES.attachment,
    description:
      "Reads a file of an email that read_mail listed, as a numbered source to cite: PDF, Word, Excel and PowerPoint documents, CSV, text, calendar, contact, XML (e-invoices) and JSON files and forwarded emails as their text; an image as its text written out and a description. A scanned PDF has no text to read. Doesn't mark the mail as read.",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message_id read_mail gave the file under." },
        file: { type: "string", description: "The file's number from read_mail, as \"2\" or \"1.3\"." },
        from_char: { type: "number", description: "Where to read on in a long file, from the note of the read before." },
      },
      required: ["message_id", "file"],
      additionalProperties: false,
    },
  },
];

const DRAFT_TOOL: AiTool = {
  name: MAIL_TOOL_NAMES.draft,
  description:
    "Saves an email as a draft in the person's Drafts folder, once they approve it; it is never sent: they send it from the Mail tab. With reply_to it answers that message in its thread, the earlier mail under it.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" }, description: "Email addresses: ones the person named, or the people of the thread it answers." },
      cc: { type: "array", items: { type: "string" } },
      subject: { type: "string", description: 'For an answer, the thread\'s subject with "Re: " before it.' },
      body: { type: "string", description: "The text, in the language the email should be in: paragraphs, - lists and **bold**. Without a signature: the mailbox's is added." },
      reply_to: { type: "string", description: "The message_id (from search_mail or read_mail) it answers." },
    },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  },
};

/** draft_mail as an agent's run has it: saved without asking, so its recipients are checked (prepareMailDraft). */
const AGENT_DRAFT_TOOL: AiTool = {
  ...DRAFT_TOOL,
  description:
    "Saves an email as a draft in the person's Drafts folder; it is never sent: they read it and send it from the Mail tab. With reply_to it answers that message in its thread, the earlier mail under it, and goes only to people of that thread; a new email goes only to addresses the person wrote in their message or task.",
};

/** What an agent's run does to the person's mail besides reading and drafting: sorting threads and keeping their summaries. */
export const AGENT_MAIL_ACTION_NAMES = { sort: "sort_mail", summary: "summarize_mail" } as const;
export const AGENT_MAIL_ACTIONS: ReadonlySet<string> = new Set(Object.values(AGENT_MAIL_ACTION_NAMES));
const SORT_ACTIONS: readonly MailSortAction[] = ["read", "unread", "star", "unstar", "archive", "move"];
const SUMMARY_CHARS = 1_500;

const AGENT_ACTION_TOOLS: AiTool[] = [
  {
    name: AGENT_MAIL_ACTION_NAMES.sort,
    description:
      "Sorts an email thread of the person's: marks it read or unread, stars or unstars it, archives it, or moves it to one of the mailbox's folders by its name. Never the trash or junk, never deleting: the person can undo any of it in the Mail tab.",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "A message_id of the thread (from read_mail, search_mail or the email that came)." },
        action: { type: "string", enum: [...SORT_ACTIONS] },
        folder: { type: "string", description: "For move: the name of the folder, as the Mail tab shows it." },
      },
      required: ["message_id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_MAIL_ACTION_NAMES.summary,
    description: `Keeps a summary of an email thread, which the Mail tab shows above it: a few short lines in the language of the email, who wants what and by when. At most ${SUMMARY_CHARS} characters; it takes the place of the thread's earlier summary.`,
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "A message_id of the thread." },
        summary: { type: "string" },
      },
      required: ["message_id", "summary"],
      additionalProperties: false,
    },
  },
];

/** The mail tools of an agent's run held to these mailboxes (agents/mail.ts runMailboxes): none without one. */
export const agentMailToolset = (boxes: readonly string[]): AiTool[] => (boxes.length ? [...READ_TOOLS, AGENT_DRAFT_TOOL, ...AGENT_ACTION_TOOLS] : []);

/**
 * The mail tools to offer in this chat: none outside the app (the Telegram bot runs as a connected
 * app), where the person can't use the Mail tab, or in research; only the reading ones where
 * changes are off.
 */
export async function chatMailToolset(userId: string, workspaceId: string, { writes }: { writes: boolean }): Promise<AiTool[]> {
  if (connectedAppCall(userId) || !(await mailTabShown(userId, workspaceId))) return [];
  return writes ? [...READ_TOOLS, DRAFT_TOOL] : READ_TOOLS;
}

export const isChatMailTool = (name: string) => (Object.values(MAIL_TOOL_NAMES) as string[]).includes(name);

const argumentNames = (tool: AiTool) => Object.keys((tool.parameters as { properties?: object }).properties ?? {});
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const shown = (a: { address: string; name: string | null }) => (a.name ? `${oneLine(a.name)} <${a.address}>` : a.address);

/** The Mail tab's address of a thread, or of a folder without `threadId`. */
export function mailPath(workspaceId: string, at: { mailboxId: string; folderId: string; threadId?: string }): string {
  const params = new URLSearchParams({ box: at.mailboxId, f: at.folderId, ...(at.threadId ? { t: at.threadId } : {}) });
  return `/w/${workspaceId}/mail?${params}`;
}

/**
 * Runs search_mail, read_mail or read_mail_attachment as `userId`, with at most `room` characters
 * of what comes back; `boxes` holds an agent's run to the mailboxes opened to it.
 */
export async function runChatMailTool(
  userId: string,
  workspaceId: string,
  call: { name: string; arguments: Record<string, unknown> },
  registry: Registry,
  room: number,
  boxes?: readonly string[],
): Promise<ToolOutcome> {
  if (room < 1_000) return { content: "There is no room left in this request to read more mail. Answer with what you have.", isError: true };
  const tool = READ_TOOLS.find((t) => t.name === call.name);
  if (!tool) return { content: `Unknown tool ${call.name}.`, isError: true };
  const refused = unknownArguments(call.name, call.arguments, argumentNames(tool));
  if (refused) return refused;
  try {
    if (call.name === MAIL_TOOL_NAMES.search) return await searchMail(userId, workspaceId, text(call.arguments.query, 500), room, boxes);
    if (call.name === MAIL_TOOL_NAMES.attachment) return await readMailAttachment(userId, workspaceId, call.arguments, registry, room, boxes);
    return await readMail(userId, workspaceId, text(call.arguments.message_id, 100), registry, room, boxes);
  } catch (error) {
    // The mail server can't be reached, or stopped answering and was closed (pool.ts ConnectionLost).
    if (error instanceof MailConnectError) return { content: "The mail server can't be reached now. Answer with what you have.", isError: true };
    if (error instanceof RowMailError || error instanceof AccessError) {
      const content =
        call.name === MAIL_TOOL_NAMES.search
          ? "The mail can't be searched now. Answer with what you have."
          : call.name === MAIL_TOOL_NAMES.attachment
            ? "No file with that message_id and number can be read. Use a message_id and file number read_mail listed."
            : "No email with that message_id can be read. Use a message_id from search_mail.";
      return { content, isError: true };
    }
    throw error;
  }
}

async function searchMail(userId: string, workspaceId: string, query: string, room: number, boxes?: readonly string[]): Promise<ToolOutcome> {
  if (!query) return { content: `${MAIL_TOOL_NAMES.search} needs a query.`, isError: true };
  const reading = await readFirst(userId, workspaceId, boxes);
  const page = await listThreads(userId, { mailboxId: ALL_INBOXES, folderId: "", workspaceId, search: query, ...(boxes ? { mailboxIds: [...boxes] } : {}) });
  const items = page.items.slice(0, SEARCH_THREADS);
  const step = { kind: "mail" as const, action: "search" as const, query, results: items.length };
  const still = reading ? " Some of the person's mail is still being read for the first time, so this search doesn't cover it yet: say so, and that asking again in a minute will." : "";
  if (!items.length) return { content: `No email matched.${still || " Try other words, or answer that the mail has nothing on it."}`, step };
  return {
    content: `${externalData(`The person's email matching "${query.replace(/"/g, "'")}" follows, newest first; read a thread with ${MAIL_TOOL_NAMES.read}.`, items.map(threadLine).join("\n\n").slice(0, room - 500))}${still ? `\n\n${still.trim()}` : ""}`,
    step,
  };
}

/**
 * Reads the mailboxes the Mail tab never opened (their folders and newest mail, as opening the tab
 * does), waiting at most FIRST_READ_MS: without it, mail of someone who never opened the tab isn't
 * in the index the search reads. Whether one is still being read.
 */
async function readFirst(userId: string, workspaceId: string, boxes?: readonly string[]): Promise<boolean> {
  const unread = (await listMailboxes(userId, workspaceId)).filter((box) => box.folders === null && box.status !== "error" && (!boxes || boxes.includes(box.id)));
  if (!unread.length) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = Promise.allSettled(unread.map((box) => openMailbox(userId, box.id))).then(() => true);
  const done = await Promise.race([read, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), FIRST_READ_MS)))]);
  clearTimeout(timer);
  return !done;
}

function threadLine(item: MailThreadItem): string {
  const marks = [`${item.count} ${item.count === 1 ? "message" : "messages"}`, item.unread ? "unread" : "", item.hasAttachments ? "with files" : "", item.hasDraft ? "with a draft" : ""].filter(Boolean);
  return [
    `message_id: ${item.messageId}`,
    `Subject: ${oneLine(item.subject) || "(no subject)"}`,
    `From: ${item.senders.map(shown).join(", ")}`,
    `Date: ${item.sentAt.slice(0, 16).replace("T", " ")} UTC · ${marks.join(" · ")}`,
    ...(item.row ? [`Row: ${oneLine(item.row.title) || "(untitled)"} (page_id ${item.row.rowId})`] : []),
    oneLine(item.preview),
  ].join("\n");
}

async function readMail(userId: string, workspaceId: string, messageId: string, registry: Registry, room: number, boxes?: readonly string[]): Promise<ToolOutcome> {
  if (!messageId) return { content: `${MAIL_TOOL_NAMES.read} needs a message_id.`, isError: true };
  const { box, message } = await ownMessage(userId, messageId);
  if (box.workspaceId !== workspaceId || (boxes && !boxes.includes(box.id))) throw new AccessError();
  const at = { mailboxId: box.id, folderId: message.folderId, threadId: message.threadId };
  const thread = await threadForAi(userId, at).catch((error) => {
    if (error instanceof AiError) throw new RowMailError("gone");
    throw error;
  });
  const row = thread.row ? `\n\nThe other party is the database row "${oneLine(thread.row.title) || "(untitled)"}" (page_id ${thread.row.rowId}).` : "";
  const files = filesText(thread.files, Math.min(FILES_CHARS, Math.floor(room / 4)));
  const path = mailPath(workspaceId, at);
  const entry = registerWeb(registry, {
    url: `${env.appUrl}${path}`,
    title: oneLine(thread.subject) || "(no subject)",
    text: `${conversationText(thread.messages, Math.min(THREAD_CHARS, room - 800) - row.length - files.length)}${files}${row}`,
  });
  return {
    // Its subject is the sender's words: it goes inside the frame (formatSources' title), never in the intro.
    content: externalData("An email thread follows.", formatSources([entry])),
    step: { kind: "mail", action: "read", subject: entry.title, url: path },
  };
}

/** Files listed per message at most, characters of a file's name, and of the whole list. */
const FILES_PER_MESSAGE = 20;
const FILE_NAME_CHARS = 150;
const FILES_CHARS = 5_000;

/** The files of a thread's messages read_mail lists, in about `max` characters, to read with read_mail_attachment; "" without any. */
function filesText(files: AiMailFiles[], max: number): string {
  if (!files.length) return "";
  const lines = files.flatMap((f) => [
    `From ${f.from} (message_id ${f.messageId}):`,
    ...f.attachments.slice(0, FILES_PER_MESSAGE).map((a) => {
      const read = mailFileKind(a.contentType, a.name) ? "" : " · not read";
      return `- file ${a.part}: ${oneLine(a.name).slice(0, FILE_NAME_CHARS)} (${oneLine(a.contentType).slice(0, 100)}, ${formatBytes(a.size)})${read}`;
    }),
    ...(f.attachments.length > FILES_PER_MESSAGE ? [`- and ${f.attachments.length - FILES_PER_MESSAGE} more`] : []),
  ]);
  let list = lines.join("\n");
  if (list.length > max) list = `${list.slice(0, Math.max(0, list.lastIndexOf("\n", max)))}\n- … and more`;
  return `\n\nFiles of these messages (read one with ${MAIL_TOOL_NAMES.attachment}):\n${list}`;
}

/** The longest a part number is: IMAP numbers parts with dots, a few levels deep. */
const PART = /^\d{1,4}(\.\d{1,4}){0,7}$/;

async function readMailAttachment(userId: string, workspaceId: string, args: Record<string, unknown>, registry: Registry, room: number, boxes?: readonly string[]): Promise<ToolOutcome> {
  const messageId = text(args.message_id, 100);
  const part = typeof args.file === "number" ? String(args.file) : text(args.file, 40);
  if (!messageId || !PART.test(part)) return { content: `${MAIL_TOOL_NAMES.attachment} needs a message_id and a file number read_mail listed.`, isError: true };
  const { box, message } = await ownMessage(userId, messageId);
  if (box.workspaceId !== workspaceId || (boxes && !boxes.includes(box.id))) throw new AccessError();
  // An agent's run takes from the workspace's allowance, as its own turns do.
  const read = await mailFileForAi(userId, workspaceId, { messageId, part }, { background: boxes !== undefined });
  const subject = oneLine(message.subject) || "(no subject)";
  const at = { mailboxId: box.id, folderId: message.folderId, threadId: message.threadId };
  const step = { kind: "mail" as const, action: "attachment" as const, name: oneLine(read.name).slice(0, FILE_NAME_CHARS), subject, url: mailPath(workspaceId, at) };
  if ("problem" in read) {
    const why = {
      kind: "Files of this kind aren't read: answer that you can't open it, and what its name and type say.",
      tooLarge: "The file is too large to read.",
      empty: "The file has no text to read: it may be a scan, an image of text in a PDF, or a locked or damaged file. Say so.",
      noImageModel: "No model here can look at images, so this image can't be read. Say so.",
      failed: "The image couldn't be read now. Answer with what you have.",
    }[read.problem];
    // Without the file's name: it is the sender's words, and this answer isn't framed.
    return { content: why, isError: true, ...(read.usage ? { usage: read.usage } : {}) };
  }

  const length = read.text.length;
  const start = Math.max(1, Math.floor(Number(args.from_char) || 1));
  if (start > length) return { content: `The file has ${length} characters.`, isError: true };
  const shown = read.text.slice(start - 1, start - 1 + Math.max(0, Math.min(FILE_CHARS, room - 1_000)));
  if (!shown) return { content: "There is no room left in this request to read more of the file. Answer with what you have.", isError: true };
  const end = start + shown.length - 1;
  const more = end < length ? `Characters ${start}-${end} of ${length}: read on with from_char ${end + 1}.` : read.partial ? "Only the start of this long file was read." : undefined;
  const as = read.kind === "image" ? "The image's text and what it shows, as a model that looked at it wrote them." : undefined;
  const entry = registerWeb(registry, {
    url: `${env.appUrl}/api/mail/attachment?${new URLSearchParams({ m: messageId, p: part })}`,
    title: `${step.name} · ${subject}`,
    text: shown,
    note: [as, more].filter(Boolean).join(" ") || undefined,
  });
  return {
    // Its name and the email's subject are the sender's words: inside the frame (the title), not in the intro.
    content: externalData("A file of an email follows.", formatSources([entry])),
    step,
    ...(read.usage ? { usage: read.usage } : {}),
  };
}

/** A draft draft_mail would save, as the person is asked about it. */
export type PreparedDraft = {
  action: ChatActionView;
  workspaceId: string;
  box: { id: string; address: string };
  input: { to: string[]; cc: string[]; subject: string; html: string; replyTo: string | null; quote: { header: string[] } | null };
};

/** An agent's run: the mailboxes opened to it, and what the person wrote it (their message or task). */
export type AgentDraftScope = { boxes: readonly string[]; typed: readonly string[] };

/**
 * Checks a draft_mail call and works out the draft: its mailbox (the answered message's, else the
 * default one, or for an agent's run the first opened to it) and its text.
 */
export async function prepareMailDraft(
  userId: string,
  workspaceId: string,
  args: Record<string, unknown>,
  timeZone?: string,
  agent?: AgentDraftScope,
): Promise<PreparedDraft | ToolOutcome> {
  const refused = unknownArguments(DRAFT_TOOL.name, args, argumentNames(DRAFT_TOOL));
  if (refused) return refused;
  const list = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v) => (typeof v === "string" ? normalizeAddress(v) : null));
  const to = list(args.to);
  const cc = list(args.cc);
  if ([...to, ...cc].some((a) => !a)) return { content: "Every recipient must be an email address.", isError: true };
  if (!to.length || to.length + cc.length > MAX_DRAFT_RECIPIENTS) return { content: `A draft goes to 1 to ${MAX_DRAFT_RECIPIENTS} addresses.`, isError: true };
  const subject = oneLine(text(args.subject, SUBJECT_CHARS));
  const body = text(args.body, DRAFT_CHARS + 1);
  if (!body) return { content: `${DRAFT_TOOL.name} needs the body.`, isError: true };
  if (body.length > DRAFT_CHARS) return { content: `The body is longer than ${DRAFT_CHARS} characters.`, isError: true };

  const replyId = text(args.reply_to, 100) || null;
  let answered: Awaited<ReturnType<typeof ownMessage>> | null = null;
  if (replyId) {
    answered = await ownMessage(userId, replyId).catch(() => null);
    if (!answered || answered.box.workspaceId !== workspaceId || (agent && !agent.boxes.includes(answered.box.id))) {
      return { content: "No email with that reply_to can be answered. Use a message_id from search_mail.", isError: true };
    }
  }
  const box = answered?.box ?? (await defaultMailbox(userId, workspaceId, agent?.boxes));
  if (!box) return { content: "The person has no mailbox here.", isError: true };
  if (agent) {
    const stranger = await strangerIn([...to, ...cc] as string[], box.address, answered ? { mailboxId: answered.box.id, threadId: answered.message.threadId } : null, agent.typed);
    if (stranger) {
      return {
        content: answered
          ? `${stranger} isn't among the people of the thread it answers: an answer goes only to them. Nothing was saved; leave them out, or give the text in your answer instead.`
          : `${stranger} isn't an address the person wrote in their message or task: a new email goes only to those. Nothing was saved; give the text in your answer instead.`,
        isError: true,
      };
    }
  }
  // The editor's Signature node (components/mail/compose-start.ts signatureBlock): sent under "-- ".
  const html = `${draftHtml(body)}${box.signature ? `<p></p><div data-signature="">${box.signature}</div>` : ""}`;
  let quote: PreparedDraft["input"]["quote"] = null;
  if (answered) {
    // The line over the earlier mail, as the composer writes it in the person's language (an
    // agent's run has no request, so no getTranslations).
    const locale = await recipientLocale(userId, "en");
    const t = createTranslator({ locale, messages: { composer: (await loadMessages(locale)).mail.composer }, namespace: "composer" });
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(answered.message.sentAt);
    quote = { header: [t("replyHeader", { date, name: answered.message.fromName || answered.message.fromAddress })] };
  }
  const addresses = (all: (string | null)[]) => [...new Set(all as string[])];
  // The card shows the text part that goes out, not the model's markdown.
  const shown = (await outgoingBody(draftHtml(body))).text || body;
  const input = { to: addresses(to), cc: addresses(cc).filter((a) => !to.includes(a)), subject, html, replyTo: answered?.message.id ?? null, quote };
  return {
    workspaceId,
    box: { id: box.id, address: box.address },
    input,
    action: { action: "draftMail", eachTime: true, target: null, title: subject, changes: [], content: shown, mail: { from: box.address, to: input.to, cc: input.cc } },
  };
}

/**
 * The first of an agent draft's recipients it may not write to, or null: for an answer, anyone but
 * the people of the thread; for a new email, anyone the person didn't write. The mailbox's own
 * address always may.
 */
async function strangerIn(recipients: string[], own: string, thread: { mailboxId: string; threadId: string } | null, typed: readonly string[]): Promise<string | null> {
  let known: Set<string>;
  if (thread) {
    const messages = await db
      .select({ from: mailMessage.fromAddress, to: mailMessage.to, cc: mailMessage.cc })
      .from(mailMessage)
      .where(and(eq(mailMessage.mailboxId, thread.mailboxId), eq(mailMessage.threadId, thread.threadId)));
    known = new Set(messages.flatMap((m) => [m.from, ...m.to.map((a) => a.address), ...m.cc.map((a) => a.address)]).map((a) => a.toLowerCase()));
  } else {
    // Each address written whole, without the sentence's last full stop or a suffix after an
    // apostrophe, straight or typographic ("ayse@acme.test’ye").
    const written = typed.join("\n").match(/[^\s@<>()",;:'’‘“”«»[\]]+@[^\s@<>()",;:'’‘“”«»[\]]+/g) ?? [];
    known = new Set(written.map((a) => normalizeAddress(a.replace(/\.+$/, ""))).filter((a): a is string => a !== null));
  }
  known.add(own.toLowerCase());
  return recipients.find((a) => !known.has(a.toLowerCase())) ?? null;
}

async function defaultMailbox(userId: string, workspaceId: string, boxes?: readonly string[]) {
  const [box] = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId), boxes ? inArray(mailbox.id, [...boxes]) : undefined))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt))
    .limit(1);
  return box ?? null;
}

/** Saves the draft the person approved, or says that nothing was saved. */
export async function saveMailDraft(userId: string, prepared: PreparedDraft, decision: "approve" | "always" | "decline"): Promise<ToolOutcome> {
  const step = { kind: "mail" as const, action: "draft" as const, subject: prepared.input.subject, to: prepared.input.to };
  if (decision === "decline") {
    return {
      content: "The person declined this draft: nothing was saved. Don't try it again; ask them what to change.",
      step: { ...step, url: null, outcome: "declined" },
    };
  }
  try {
    await saveDraft(userId, { mailboxId: prepared.box.id, bcc: [], ...prepared.input });
  } catch (error) {
    if (!(error instanceof RowMailError || error instanceof AccessError)) throw error;
    return { content: "The draft couldn't be saved on the mail server. Give the text in the answer instead.", isError: true, step: { ...step, url: null, outcome: "failed" } };
  }
  const [drafts] = await db
    .select({ id: mailFolder.id })
    .from(mailFolder)
    .where(and(eq(mailFolder.mailboxId, prepared.box.id), eq(mailFolder.role, "drafts")));
  return {
    content: `The draft is saved in the Drafts folder of ${prepared.box.address}. It is not sent: the person reviews and sends it from the Mail tab.`,
    step: { ...step, url: drafts ? mailPath(prepared.workspaceId, { mailboxId: prepared.box.id, folderId: drafts.id }) : null, outcome: "done" },
  };
}

/**
 * Notes on a message what an agent did with it (`mail_message.agent_marks`), once per deed: the Mail
 * tab marks its thread. Never throws: the mark is a courtesy, not the work.
 */
export async function markMail(messageId: string, agentId: string, deed: MailAgentDeed) {
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ marks: mailMessage.agentMarks }).from(mailMessage).where(eq(mailMessage.id, messageId)).for("update");
      if (!row) return;
      const marks: MailAgentMark[] = row.marks ?? [];
      const mine = marks.find((m) => m.agentId === agentId);
      const at = new Date().toISOString();
      const next = mine
        ? marks.map((m) => (m === mine ? { ...m, did: m.did.includes(deed) ? m.did : [...m.did, deed], at } : m))
        : [...marks, { agentId, did: [deed], at }];
      await tx.update(mailMessage).set({ agentMarks: next }).where(eq(mailMessage.id, messageId));
    });
  } catch (error) {
    console.warn("[mail] could not mark a message an agent worked on:", (error as Error)?.message ?? error);
  }
}

/**
 * Runs sort_mail or summarize_mail for an agent's run, as `userId` (the mailbox's owner), on a
 * thread of the mailboxes opened to it (`boxes`).
 */
export async function runAgentMailAction(
  userId: string,
  workspaceId: string,
  call: { name: string; arguments: Record<string, unknown> },
  scope: { boxes: readonly string[]; agentId: string },
): Promise<ToolOutcome> {
  const tool = AGENT_ACTION_TOOLS.find((t) => t.name === call.name);
  if (!tool) return { content: `Unknown tool ${call.name}.`, isError: true };
  const refused = unknownArguments(call.name, call.arguments, argumentNames(tool));
  if (refused) return refused;
  const found = await ownMessage(userId, text(call.arguments.message_id, 100)).catch(() => null);
  if (!found || found.box.workspaceId !== workspaceId || !scope.boxes.includes(found.box.id)) {
    return { content: "No email with that message_id can be found. Use a message_id from read_mail or search_mail.", isError: true };
  }
  const { box, message } = found;
  const subject = oneLine(message.subject) || "(no subject)";
  const url = mailPath(workspaceId, { mailboxId: box.id, folderId: message.folderId, threadId: message.threadId });

  if (call.name === AGENT_MAIL_ACTION_NAMES.summary) {
    const summary = text(call.arguments.summary, SUMMARY_CHARS + 1);
    if (!summary) return { content: `${call.name} needs the summary.`, isError: true };
    if (summary.length > SUMMARY_CHARS) return { content: `The summary is longer than ${SUMMARY_CHARS} characters.`, isError: true };
    // On the thread's newest message, as the Mail tab keeps the summaries it makes (mail-client/ai.ts).
    const [newest] = await db
      .select({ id: mailMessage.id })
      .from(mailMessage)
      .where(and(eq(mailMessage.mailboxId, box.id), eq(mailMessage.threadId, message.threadId), eq(mailMessage.draft, false)))
      .orderBy(desc(mailMessage.sentAt))
      .limit(1);
    if (!newest) return { content: "That thread has nothing to summarize.", isError: true };
    await saveSummary(newest.id, summary);
    await markMail(newest.id, scope.agentId, "summarized");
    return { content: "The summary is kept: the Mail tab shows it above the thread.", step: { kind: "mail", action: "summary", subject, url } };
  }

  const action = SORT_ACTIONS.find((a) => a === call.arguments.action);
  if (!action) return { content: `action is one of ${SORT_ACTIONS.join(", ")}.`, isError: true };
  let to: { id: string; name: string } | null = null;
  if (action === "move") {
    const name = text(call.arguments.folder, 200).toLocaleLowerCase();
    const folders = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
    const target = folders.find((f) => f.name.toLocaleLowerCase() === name || f.path.toLocaleLowerCase() === name);
    if (!target || !movableTo(target) || target.role === "trash" || target.role === "junk" || target.id === message.folderId) {
      const names = folders.filter((f) => movableTo(f) && f.role !== "trash" && f.role !== "junk" && f.id !== message.folderId).map((f) => `"${f.name}"`);
      return { content: `There is no folder "${name}" to move it to. The folders: ${names.join(", ") || "none"}.`, isError: true };
    }
    to = { id: target.id, name: target.name };
  } else if (call.arguments.folder !== undefined) {
    return { content: "folder goes only with action move.", isError: true };
  }
  try {
    await mailAction(userId, { mailboxId: box.id, folderId: message.folderId, threadIds: [message.threadId], action, ...(to ? { to: to.id } : {}) });
  } catch (error) {
    if (!(error instanceof RowMailError || error instanceof AccessError)) throw error;
    return { content: "The mail server didn't take the change. Leave the thread as it is.", isError: true };
  }
  // The message keeps its row when it moves (write.ts), so its mark goes along.
  await markMail(message.id, scope.agentId, "sorted");
  const where = action === "move" || action === "archive" ? (await locate(message.id)) ?? url : url;
  return { content: `Done: the thread is ${SORT_DONE[action]}${to ? ` "${to.name}"` : ""}.`, step: { kind: "mail", action: "sort", subject, did: action, folder: to?.name ?? null, url: where } };
}

const SORT_DONE: Record<MailSortAction, string> = { read: "marked read", unread: "marked unread", star: "starred", unstar: "unstarred", archive: "archived", move: "moved to" };

/** The Mail tab's address of a message's thread where it is now (after a move), or null when it left the index. */
async function locate(messageId: string) {
  const [row] = await db
    .select({ mailboxId: mailMessage.mailboxId, folderId: mailMessage.folderId, threadId: mailMessage.threadId, workspaceId: sql<string>`(select ${mailbox.workspaceId} from ${mailbox} where ${mailbox.id} = ${mailMessage.mailboxId})` })
    .from(mailMessage)
    .where(eq(mailMessage.id, messageId));
  return row ? mailPath(row.workspaceId, row) : null;
}
