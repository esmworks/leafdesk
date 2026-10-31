/**
 * The AI chat on the person's own mail, where they may use the Mail tab in the workspace
 * (mail-client/read.ts mailTabShown): `search_mail` and `read_mail` read it as the tab does (never
 * marking anything seen), `draft_mail` saves a draft in their Drafts folder. Nothing here sends
 * mail: the person sends a draft from the Mail tab.
 *
 * Mail is anyone's words. What the tools read comes back framed as data from outside, and once an
 * answer read mail, ai-chat.ts asks the person before every change and note for the rest of it,
 * even in Auto. A draft could carry what the model read to an address an email named: each is
 * asked about in every mode, showing its sender, every recipient, the subject and the text, and
 * "don't ask again" isn't offered. Only the person's own chat in the app has these tools: not
 * research, the Telegram bot (a connected app), agents, MCP or use_tool (mail-client/access.ts).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { mailbox, mailFolder } from "@/db/schema";
import type { ChatActionView } from "@/lib/ai-chat";
import { env } from "@/lib/env";
import { normalizeAddress } from "@/lib/mail";
import { draftHtml } from "@/lib/mail-ai";
import { ALL_INBOXES, type MailThreadItem } from "@/lib/mail-client";
import { AccessError } from "@/server/access";
import { AiError, type AiTool } from "@/server/ai";
import { externalData } from "@/server/ai/frame";
import { formatSources } from "@/server/ai/prompts";
import { registerWeb, unknownArguments, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { connectedAppCall } from "@/server/connected-app";
import { recipientLocale } from "@/server/mail/locale";
import { RowMailError } from "@/server/row-mail/settings";
import { threadForAi } from "@/server/mail-client/ai";
import { conversationText } from "@/server/mail-client/ai-prompts";
import { saveDraft } from "@/server/mail-client/drafts";
import { outgoingBody } from "@/server/mail-client/outgoing";
import { listMailboxes, listThreads, mailTabShown, openMailbox, ownMessage } from "@/server/mail-client/read";

export const MAIL_TOOL_NAMES = { search: "search_mail", read: "read_mail", draft: "draft_mail" } as const;

/** Threads a search lists, a thread's text read, and a draft's recipients and text, at most. */
const SEARCH_THREADS = 15;
const THREAD_CHARS = 20_000;
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
      "Reads an email thread by a message_id from search_mail: its last messages, oldest first, as a numbered source to cite, and the database row its other party is, when there is one (read it with read_page). Doesn't mark the mail as read.",
    parameters: {
      type: "object",
      properties: { message_id: { type: "string", description: "A message_id from search_mail." } },
      required: ["message_id"],
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

/**
 * The mail tools to offer in this chat: none outside the app (the Telegram bot runs as a connected
 * app), where the person can't use the Mail tab, or in research; only the reading ones where
 * changes are off.
 */
export async function chatMailToolset(userId: string, workspaceId: string, { writes }: { writes: boolean }): Promise<AiTool[]> {
  if (connectedAppCall(userId) || !(await mailTabShown(userId, workspaceId))) return [];
  return writes ? [...READ_TOOLS, DRAFT_TOOL] : READ_TOOLS;
}

export const isChatMailTool = (name: string) => name === MAIL_TOOL_NAMES.search || name === MAIL_TOOL_NAMES.read || name === MAIL_TOOL_NAMES.draft;

const argumentNames = (tool: AiTool) => Object.keys((tool.parameters as { properties?: object }).properties ?? {});
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const shown = (a: { address: string; name: string | null }) => (a.name ? `${oneLine(a.name)} <${a.address}>` : a.address);

/** The Mail tab's address of a thread, or of a folder without `threadId`. */
export function mailPath(workspaceId: string, at: { mailboxId: string; folderId: string; threadId?: string }): string {
  const params = new URLSearchParams({ box: at.mailboxId, f: at.folderId, ...(at.threadId ? { t: at.threadId } : {}) });
  return `/w/${workspaceId}/mail?${params}`;
}

/** Runs search_mail or read_mail as `userId`, with at most `room` characters of what comes back. */
export async function runChatMailTool(
  userId: string,
  workspaceId: string,
  call: { name: string; arguments: Record<string, unknown> },
  registry: Registry,
  room: number,
): Promise<ToolOutcome> {
  if (room < 1_000) return { content: "There is no room left in this request to read more mail. Answer with what you have.", isError: true };
  const tool = READ_TOOLS.find((t) => t.name === call.name);
  if (!tool) return { content: `Unknown tool ${call.name}.`, isError: true };
  const refused = unknownArguments(call.name, call.arguments, argumentNames(tool));
  if (refused) return refused;
  try {
    return call.name === MAIL_TOOL_NAMES.search ? await searchMail(userId, workspaceId, text(call.arguments.query, 500), room) : await readMail(userId, workspaceId, text(call.arguments.message_id, 100), registry, room);
  } catch (error) {
    if (error instanceof RowMailError || error instanceof AccessError) {
      return { content: call.name === MAIL_TOOL_NAMES.search ? "The mail can't be searched now. Answer with what you have." : "No email with that message_id can be read. Use a message_id from search_mail.", isError: true };
    }
    throw error;
  }
}

async function searchMail(userId: string, workspaceId: string, query: string, room: number): Promise<ToolOutcome> {
  if (!query) return { content: `${MAIL_TOOL_NAMES.search} needs a query.`, isError: true };
  const reading = await readFirst(userId, workspaceId);
  const page = await listThreads(userId, { mailboxId: ALL_INBOXES, folderId: "", workspaceId, search: query });
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
async function readFirst(userId: string, workspaceId: string): Promise<boolean> {
  const unread = (await listMailboxes(userId, workspaceId)).filter((box) => box.folders === null && box.status !== "error");
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

async function readMail(userId: string, workspaceId: string, messageId: string, registry: Registry, room: number): Promise<ToolOutcome> {
  if (!messageId) return { content: `${MAIL_TOOL_NAMES.read} needs a message_id.`, isError: true };
  const { box, message } = await ownMessage(userId, messageId);
  if (box.workspaceId !== workspaceId) throw new AccessError();
  const at = { mailboxId: box.id, folderId: message.folderId, threadId: message.threadId };
  const thread = await threadForAi(userId, at).catch((error) => {
    if (error instanceof AiError) throw new RowMailError("gone");
    throw error;
  });
  const row = thread.row ? `\n\nThe other party is the database row "${oneLine(thread.row.title) || "(untitled)"}" (page_id ${thread.row.rowId}).` : "";
  const path = mailPath(workspaceId, at);
  const entry = registerWeb(registry, {
    url: `${env.appUrl}${path}`,
    title: oneLine(thread.subject) || "(no subject)",
    text: `${conversationText(thread.messages, Math.min(THREAD_CHARS, room - 800) - row.length)}${row}`,
  });
  return {
    content: externalData(`The email thread "${entry.title.replace(/"/g, "'")}" follows.`, formatSources([entry])),
    step: { kind: "mail", action: "read", subject: entry.title, url: path },
  };
}

/** A draft draft_mail would save, as the person is asked about it. */
export type PreparedDraft = {
  action: ChatActionView;
  workspaceId: string;
  box: { id: string; address: string };
  input: { to: string[]; cc: string[]; subject: string; html: string; replyTo: string | null; quote: { header: string[] } | null };
};

/** Checks a draft_mail call and works out the draft: its mailbox (the answered message's, else the default one) and its text. */
export async function prepareMailDraft(userId: string, workspaceId: string, args: Record<string, unknown>, timeZone?: string): Promise<PreparedDraft | ToolOutcome> {
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
    if (!answered || answered.box.workspaceId !== workspaceId) return { content: "No email with that reply_to can be answered. Use a message_id from search_mail.", isError: true };
  }
  const box = answered?.box ?? (await defaultMailbox(userId, workspaceId));
  if (!box) return { content: "The person has no mailbox here.", isError: true };
  // The editor's Signature node (components/mail/compose-start.ts signatureBlock): sent under "-- ".
  const html = `${draftHtml(body)}${box.signature ? `<p></p><div data-signature="">${box.signature}</div>` : ""}`;
  let quote: PreparedDraft["input"]["quote"] = null;
  if (answered) {
    // The line over the earlier mail, as the composer writes it in the person's language.
    const locale = await recipientLocale(userId, "en");
    const t = await getTranslations({ locale, namespace: "mail.composer" });
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

async function defaultMailbox(userId: string, workspaceId: string) {
  const [box] = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt))
    .limit(1);
  return box ?? null;
}

/** Saves the draft the person approved, or says that nothing was saved. */
export async function saveMailDraft(userId: string, prepared: PreparedDraft, decision: "approve" | "always" | "decline" | "timeout"): Promise<ToolOutcome> {
  const step = { kind: "mail" as const, action: "draft" as const, subject: prepared.input.subject, to: prepared.input.to };
  if (decision === "decline" || decision === "timeout") {
    return {
      content:
        decision === "timeout"
          ? "The person didn't answer in time, so no draft was saved. Give the text in the answer instead."
          : "The person declined this draft: nothing was saved. Don't try it again; ask them what to change.",
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
