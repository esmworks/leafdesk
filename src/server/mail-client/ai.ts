/**
 * The Mail tab's AI, for the mailbox's owner alone (access.ts): a thread's summary, saved on its
 * newest message (`mail_message.summary`), and the composer's writer. Both read mail through
 * read.ts without marking it read, and run only when the person asks: nothing reads mail for the
 * AI in the background. Streamed to the browser by `POST /api/ai/mail`.
 */
import { and, eq, ne } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { mailMessage } from "@/db/schema";
import { isAiLanguage } from "@/lib/ai";
import { DRAFT_ACTIONS, MAIL_WRITE_ACTIONS, MAX_MAIL_INSTRUCTION, SUMMARY_MESSAGES } from "@/lib/mail-ai";
import { aiConfig, AiError, contentChars, stream, type AiStream } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { requireOwnMailbox } from "./access";
import { summaryPrompt, writePrompt, type AiMailMessage } from "./ai-prompts";
import { getThread, messageForAi } from "./read";

/** Room left for mail in a prompt after the instructions. */
const PROMPT_OVERHEAD = 2_000;
const id = z.string().min(1).max(100);

export const mailAiInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("summary"),
    mailboxId: id,
    folderId: id,
    threadId: z.string().min(1).max(300),
    /** The language the person reads the app in; the summary is written in it. */
    language: z.string().max(20).optional(),
  }),
  z.object({
    kind: z.literal("write"),
    mailboxId: id,
    action: z.enum(MAIL_WRITE_ACTIONS),
    /** What is written above the signature and the quoted mail, as plain text. */
    draft: z.string().max(200_000),
    instruction: z.string().max(MAX_MAIL_INSTRUCTION).optional(),
    /** translate: the target language code. */
    language: z.string().max(20).optional(),
    subject: z.string().max(2_000).optional(),
    to: z.array(z.string().max(400)).max(100).optional(),
    /** The message answered or forwarded, by its id in the index. */
    answering: id.nullish(),
  }),
]);
export type MailAiInput = z.infer<typeof mailAiInput>;

export type MailAiAnswer = {
  answer: AiStream;
  /** Called with the whole text once the model has finished it. */
  finished?: (text: string) => Promise<void>;
};

const roomFor = (taken = 0) => Math.max(1_000, contentChars(aiConfig().limits) - PROMPT_OVERHEAD - taken);

const asAiMessage = (found: Awaited<ReturnType<typeof messageForAi>>): AiMailMessage => ({
  from: { address: found.message.fromAddress, name: found.message.fromName },
  sentAt: found.message.sentAt,
  text: found.text,
  mine: found.message.fromAddress === found.box.address,
});

/** Starts what `input` asks for. Throws AiError when AI is off or the request can't run, RowMailError when the mail can't be read. */
export async function startMailAi(userId: string, input: MailAiInput, signal?: AbortSignal): Promise<MailAiAnswer> {
  const box = await requireOwnMailbox(userId, input.mailboxId);
  if (!(await aiAvailable(box.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  return input.kind === "summary" ? summarize(userId, box.workspaceId, input, signal) : write(userId, box.workspaceId, input, signal);
}

async function summarize(userId: string, workspaceId: string, input: Extract<MailAiInput, { kind: "summary" }>, signal?: AbortSignal): Promise<MailAiAnswer> {
  const thread = await getThread(userId, { mailboxId: input.mailboxId, threadId: input.threadId, folderId: input.folderId });
  const read = thread.messages.slice(-SUMMARY_MESSAGES);
  // One after another on the mailbox's connection: most were just opened and come from memory.
  const messages: AiMailMessage[] = [];
  for (const m of read) {
    const found = await messageForAi(userId, m.id).catch(() => null);
    messages.push(found ? asAiMessage(found) : { from: m.from, sentAt: new Date(m.sentAt), text: m.preview, mine: false });
  }
  const prompt = summaryPrompt({ subject: thread.subject, messages, language: isAiLanguage(input.language) ? input.language : undefined }, roomFor());
  const newest = thread.messages[thread.messages.length - 1];
  const answer = await stream({ feature: "mail.summary", userId, workspaceId, system: prompt.system, messages: [{ role: "user", content: prompt.prompt }], signal });
  return { answer, finished: (text) => saveSummary(newest.id, text) };
}

/** Keeps the summary on the thread's newest message, and drops the thread's older ones. */
async function saveSummary(messageId: string, text: string) {
  const summary = text.trim();
  if (!summary) return;
  const [row] = await db.update(mailMessage).set({ summary }).where(eq(mailMessage.id, messageId)).returning({ mailboxId: mailMessage.mailboxId, threadId: mailMessage.threadId });
  if (row) await db.update(mailMessage).set({ summary: null }).where(and(eq(mailMessage.mailboxId, row.mailboxId), eq(mailMessage.threadId, row.threadId), ne(mailMessage.id, messageId)));
}

async function write(userId: string, workspaceId: string, input: Extract<MailAiInput, { kind: "write" }>, signal?: AbortSignal): Promise<MailAiAnswer> {
  const { action } = input;
  const draft = input.draft.trim();
  if (DRAFT_ACTIONS.includes(action) && !draft) throw new AiError("invalid", "Write something first");
  if (action === "translate" && !isAiLanguage(input.language)) throw new AiError("invalid", "Choose a language to translate into");
  if (action === "custom" && !input.instruction?.trim()) throw new AiError("invalid", "Say what the AI should do");
  if (action === "reply" && !input.answering) throw new AiError("invalid", "There is no message to reply to");
  // The answer replaces the draft, so it is never cut to fit.
  const room = roomFor(input.instruction?.length ?? 0);
  if (draft.length > room) throw new AiError("tooLarge", "The message is too long for one request");
  const answering = input.answering ? asAiMessage(await messageForAi(userId, input.answering)) : null;
  const prompt = writePrompt(
    { action, draft, instruction: input.instruction, language: input.language, subject: input.subject, to: input.to, answering },
    room,
  );
  const answer = await stream({ feature: "mail.write", userId, workspaceId, system: prompt.system, messages: [{ role: "user", content: prompt.prompt }], signal });
  return { answer };
}
