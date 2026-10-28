import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import { db } from "@/db";
import { mailbox, rowEmail, user } from "@/db/schema";
import { MAX_MAIL_TEXT, MAX_SENDS_PER_HOUR, normalizeAddress, SEND_RETRY_MINUTES } from "@/lib/mail";
import { AccessError } from "@/server/access";
import { startSweep } from "@/server/sweep";
import { workspaceSettings } from "@/server/workspaces";
import { requestRowMailAccess } from "./access";
import { connectError, openImap, smtpTransport } from "./connect";
import { withMailCredentials } from "./credentials";
import { RowMailError } from "./settings";

/**
 * Mail written on a row goes out from the writer's own mailbox: queued here, then sent by the
 * sweep below (one sweep takes a message at a time, so two servers never send it twice), retried
 * after 1, 5 and 30 minutes, and put in the mailbox's sent folder so it shows in the member's
 * mail program too.
 */

/** Recipients a message may have, To and Cc together. */
const MAX_RECIPIENTS = 50;
/** How long a message being sent is held before another sweep may try it again (a crash midway). */
const SEND_LEASE_MINUTES = 10;
/** Messages a sweep sends. */
const BATCH = 10;
/** Servers that put what is sent through them in the sent folder themselves. */
const SAVES_SENT = ["imap.gmail.com"];

export type RowEmailDraft = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** The message on the row this answers. */
  replyTo?: string | null;
};

function addresses(values: unknown): string[] {
  if (!Array.isArray(values)) throw new RowMailError("invalid");
  const out = values.map(normalizeAddress);
  if (out.some((a) => !a)) throw new RowMailError("invalid");
  return [...new Set(out as string[])];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Queues a message from the user's mailbox on row `rowId` (edit access); returns its id. `within`
 * runs in the same transaction once the message is in (a follow-up recording the step it sent):
 * when it throws, the message isn't queued.
 */
export async function queueRowEmail(userId: string, rowId: string, draft: RowEmailDraft, { within }: { within?: (tx: Tx, id: string) => Promise<void> } = {}): Promise<string> {
  const access = await requestRowMailAccess(userId, rowId);
  if (!access || (access.level !== "edit" && access.level !== "full")) throw new AccessError();
  if (!(await workspaceSettings(access.workspaceId)).email) throw new RowMailError("disabled");
  const [box] = await db
    .select({ id: mailbox.id, address: mailbox.address, displayName: mailbox.displayName, name: user.name })
    .from(mailbox)
    .innerJoin(user, eq(user.id, mailbox.userId))
    .where(and(eq(mailbox.workspaceId, access.workspaceId), eq(mailbox.userId, userId)));
  if (!box) throw new RowMailError("noMailbox");
  const to = addresses(draft?.to);
  const cc = addresses(draft?.cc ?? []).filter((a) => !to.includes(a));
  const subject = typeof draft.subject === "string" ? draft.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 900) : "";
  const text = typeof draft.text === "string" ? draft.text.replace(/\r\n/g, "\n") : "";
  if (!to.length || to.length + cc.length > MAX_RECIPIENTS || text.length > MAX_MAIL_TEXT || (!subject && !text.trim())) {
    throw new RowMailError("invalid");
  }
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (draft.replyTo) {
    const [earlier] = await db
      .select({ messageId: rowEmail.messageId, references: rowEmail.references })
      .from(rowEmail)
      .where(and(eq(rowEmail.id, draft.replyTo), eq(rowEmail.rowId, rowId)));
    if (!earlier) throw new RowMailError("gone");
    inReplyTo = earlier.messageId;
    references = [...earlier.references, earlier.messageId].slice(-20);
  }
  const domain = box.address.split("@")[1];
  return db.transaction(async (tx) => {
    // One at a time per mailbox past here, so the count is current.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:row-mail-send:${box.id}`}))`);
    const [sent] = await tx
      .select({ n: count() })
      .from(rowEmail)
      .where(and(eq(rowEmail.mailboxId, box.id), eq(rowEmail.direction, "out"), gt(rowEmail.createdAt, sql`now() - interval '1 hour'`)));
    if ((sent?.n ?? 0) >= MAX_SENDS_PER_HOUR) throw new RowMailError("rateLimited");
    const [queued] = await tx
      .insert(rowEmail)
      .values({
        workspaceId: access.workspaceId,
        mailboxId: box.id,
        databaseId: access.databaseId,
        rowId,
        direction: "out",
        messageId: `${crypto.randomUUID()}@${domain}`,
        inReplyTo,
        references,
        fromAddress: box.address,
        fromName: box.displayName || box.name,
        to,
        cc,
        subject,
        text,
        sentAt: new Date(),
        status: "queued",
        nextAttemptAt: new Date(),
        sentBy: userId,
      })
      .returning({ id: rowEmail.id });
    await within?.(tx, queued.id);
    return queued.id;
  });
}

/** Takes due messages, holding each for SEND_LEASE_MINUTES while it is sent. */
async function claim() {
  const taken = await db.execute<{ id: string }>(sql`
    update ${rowEmail} set attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => ${SEND_LEASE_MINUTES})
    where id in (
      select id from ${rowEmail}
      where status = 'queued' and next_attempt_at <= now()
      order by next_attempt_at
      limit ${BATCH}
      for update skip locked
    )
    returning id
  `);
  const ids = [...taken].map((r) => r.id);
  if (!ids.length) return [];
  return db.select().from(rowEmail).where(inArray(rowEmail.id, ids));
}

const angle = (id: string) => `<${id}>`;

/** The message as it goes out, in MIME, so the same bytes are sent and kept in the sent folder. */
export function composeRowEmail(email: Pick<typeof rowEmail.$inferSelect, "fromAddress" | "fromName" | "to" | "cc" | "subject" | "text" | "messageId" | "inReplyTo" | "references" | "sentAt">) {
  return new MailComposer({
    from: { name: email.fromName ?? "", address: email.fromAddress },
    to: email.to,
    cc: email.cc.length ? email.cc : undefined,
    subject: email.subject,
    text: email.text,
    messageId: angle(email.messageId),
    inReplyTo: email.inReplyTo ? angle(email.inReplyTo) : undefined,
    references: email.references.length ? email.references.map(angle) : undefined,
    date: email.sentAt,
  })
    .compile()
    .build();
}

/** Why sending failed, for the row: short and without anything the server echoed of the password or token. */
const failure = (error: unknown) => {
  const e = connectError(error);
  return `${e.code}: ${e.message}`
    .replace(/(pass(word)?|auth)[^\s]*\s*[:=]\s*\S+/gi, "$1 ***")
    .replace(/(bearer|xoauth2)\s+\S+/gi, "$1 ***")
    .slice(0, 500);
};

/** Whether trying again can't help: the server refused the sign-in or the message for good. */
function permanent(error: unknown) {
  const e = error as { responseCode?: number };
  const code = connectError(error).code;
  return code === "auth" || code === "signIn" || code === "blocked" || (typeof e?.responseCode === "number" && e.responseCode >= 500);
}

async function send(email: typeof rowEmail.$inferSelect) {
  // Hidden (taken back) since it was claimed, or already done by another try.
  const [current] = await db.select({ status: rowEmail.status }).from(rowEmail).where(eq(rowEmail.id, email.id));
  if (current?.status !== "queued") return;
  const [box] = email.mailboxId ? await db.select().from(mailbox).where(eq(mailbox.id, email.mailboxId)) : [];
  if (!box) {
    await db.update(rowEmail).set({ status: "failed", error: "noMailbox", nextAttemptAt: null }).where(eq(rowEmail.id, email.id));
    return;
  }
  const raw = await composeRowEmail(email);
  try {
    await sendRaw(box, raw, [...email.to, ...email.cc]);
  } catch (error) {
    const retry = SEND_RETRY_MINUTES[email.attempts - 1];
    const giveUp = permanent(error) || retry === undefined;
    await db
      .update(rowEmail)
      .set({
        status: giveUp ? "failed" : "queued",
        error: failure(error),
        nextAttemptAt: giveUp ? null : new Date(Date.now() + retry * 60_000),
      })
      .where(and(eq(rowEmail.id, email.id), eq(rowEmail.status, "queued")));
    return;
  }
  await db
    .update(rowEmail)
    .set({ status: "sent", error: null, nextAttemptAt: null, sentAt: new Date() })
    .where(eq(rowEmail.id, email.id));
  await keepSent(box, raw);
}

type Mailbox = typeof mailbox.$inferSelect;

/** Sends a composed message through the mailbox's server; throws what the server answered. */
async function sendRaw(box: Mailbox, raw: Buffer, recipients: string[]) {
  await withMailCredentials(box, async (credentials) => {
    const transport = await smtpTransport(credentials);
    try {
      await transport.sendMail({ envelope: { from: box.address, to: recipients }, raw });
    } finally {
      transport.close();
    }
  });
}

/** Puts a sent message in the mailbox's sent folder, where its server doesn't itself; a failure only warns. */
async function keepSent(box: Mailbox, raw: Buffer) {
  if (!box.folders.sent || SAVES_SENT.includes(box.imapHost)) return;
  try {
    const client = await withMailCredentials(box, openImap);
    try {
      await client.append(box.folders.sent.path, raw, ["\\Seen"]);
    } finally {
      await client.logout().catch(() => {});
    }
  } catch (error) {
    console.warn("[row-mail] could not save a sent message in the sent folder", connectError(error).code);
  }
}

/**
 * Sends a message on no row from the mailbox at once (an agent's email to its recipients,
 * agents/send-mail.ts), and keeps it in the sent folder: nothing is queued or retried. Throws
 * what the server answered, as `failure` words it.
 */
export async function sendFromMailbox(box: Mailbox, message: { fromName: string; to: string[]; subject: string; text: string }) {
  const raw = await composeRowEmail({
    ...message,
    fromAddress: box.address,
    cc: [],
    messageId: `${crypto.randomUUID()}@${box.address.split("@")[1]}`,
    inReplyTo: null,
    references: [],
    sentAt: new Date(),
  });
  try {
    await sendRaw(box, raw, message.to);
  } catch (error) {
    throw new Error(failure(error), { cause: error });
  }
  await keepSent(box, raw);
}

/** Sends what is due; returns how many it tried. */
export async function sendDue() {
  let tried = 0;
  for (;;) {
    const batch = await claim();
    if (!batch.length) return tried;
    for (const email of batch) {
      try {
        await send(email);
      } catch (error) {
        console.error("[row-mail] sending failed", error);
      }
      tried += 1;
    }
  }
}

let stop: (() => void) | null = null;
let kick: Promise<unknown> | null = null;

/** Sends a queued message now rather than at the next sweep (the sweep still covers a crash). */
export function sendSoon() {
  kick ??= sendDue()
    .catch((error) => console.error("[row-mail] sending failed", error))
    .finally(() => (kick = null));
}

/** Sends due mail every 30 seconds (server.ts). */
export function startRowMailSender() {
  stop ??= startSweep(30_000, sendDue, "[row-mail] send sweep failed");
  return stop;
}
