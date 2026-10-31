"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { MailAction, MailAddress, MailBody, MailboxTabView, MailDraftInput, MailDraftRef, MailDraftView, MailFolderView, MailHeldSend, MailSavedDraft, MailSendStatus, MailThreadPage, MailThreadView, MailUndoneSend } from "@/lib/mail-client";
import { AccessError } from "@/server/access";
import { getThread, listMailboxes, listThreads, openMailbox, prefetchBodies, readBody, refreshFolder, refreshMailbox } from "@/server/mail-client/read";
import { suggestAddresses } from "@/server/mail-client/contacts";
import { discardDraft, openDraft, saveDraft } from "@/server/mail-client/drafts";
import { forgetImageSender, trustImageSender } from "@/server/mail-client/images";
import { holdMail, mailAction, sendStatus, undoSend } from "@/server/mail-client/write";
import { MailConnectError } from "@/server/row-mail/connect";
import { RowMailError } from "@/server/row-mail/settings";
import { requireUserId } from "@/server/session";

// The Mail tab (see server/mail-client): a member reads and writes the mail of their own mailboxes.
// Reads are served through app/api/read; expected failures come back translated, as Next.js hides
// thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("settings.email.errors");
    if (error instanceof RowMailError) return { ok: false, error: t(error.code), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    // The mail server refused the connection or dropped it (server/mail-client/pool.ts).
    if (error instanceof MailConnectError) return { ok: false, error: t(error.code), code: error.code };
    console.error("[mail action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

export async function listMailboxesAction(workspaceId: string): Promise<ActionResult<MailboxTabView[]>> {
  return run((userId) => listMailboxes(userId, workspaceId));
}

export async function openMailboxAction(mailboxId: string): Promise<ActionResult<MailboxTabView>> {
  return run((userId) => openMailbox(userId, mailboxId));
}

export async function refreshFolderAction(mailboxId: string, folderId: string): Promise<ActionResult<MailFolderView[]>> {
  return run((userId) => refreshFolder(userId, mailboxId, folderId));
}

export async function listThreadsAction(input: { mailboxId: string; folderId: string; search?: string; cursor?: string | null }): Promise<ActionResult<MailThreadPage>> {
  return run((userId) => listThreads(userId, input));
}

export async function getThreadAction(input: { mailboxId: string; threadId: string; folderId: string }): Promise<ActionResult<MailThreadView>> {
  return run((userId) => getThread(userId, input));
}

export async function readBodyAction(input: { id: string; images?: boolean }): Promise<ActionResult<MailBody>> {
  return run((userId) => readBody(userId, input));
}

export async function prefetchBodiesAction(input: { ids: string[] }): Promise<ActionResult<null>> {
  return run((userId) => prefetchBodies(userId, input));
}

/** The addresses a recipient field suggests for what is typed in it. */
export async function suggestAddressesAction(input: { mailboxId: string; query: string }): Promise<ActionResult<MailAddress[]>> {
  return run((userId) => suggestAddresses(userId, input));
}

/** Always loads images in mail from this sender to the mailbox. */
export async function trustImageSenderAction(input: { mailboxId: string; address: string }): Promise<ActionResult<null>> {
  return run((userId) => trustImageSender(userId, input));
}

/** Stops loading images from this sender unless asked (from a message or from Settings). */
export async function forgetImageSenderAction(input: { mailboxId: string; address: string }): Promise<ActionResult<null>> {
  return run((userId) => forgetImageSender(userId, input));
}

export async function refreshMailboxAction(mailboxId: string): Promise<ActionResult<MailboxTabView>> {
  return run((userId) => refreshMailbox(userId, mailboxId));
}

export async function mailActionAction(input: { mailboxId: string; folderId: string; threadIds: string[]; action: MailAction; to?: string }): Promise<ActionResult<null>> {
  return run(async (userId) => {
    await mailAction(userId, input);
    return null;
  });
}

/** A message the composer sent: `draft` as JSON under "draft", the files added since its last save under "file". */
function composed(form: FormData) {
  let draft: MailDraftInput;
  try {
    draft = JSON.parse(String(form.get("draft") ?? ""));
  } catch {
    throw new RowMailError("invalid");
  }
  if (!draft || typeof draft !== "object") throw new RowMailError("invalid");
  return { draft, files: form.getAll("file").filter((f): f is File => f instanceof File) };
}

/** Sends a message (see `composed`); the draft it was saved as goes. */
/** Sends what the composer holds after the seconds Undo has (see `composed`). */
export async function sendMailAction(form: FormData): Promise<ActionResult<MailHeldSend>> {
  return run(async (userId) => {
    const { draft, files } = composed(form);
    return holdMail(userId, draft, files);
  });
}

/** Takes back a message still waiting to go: it is a draft again. Null when it went already. */
export async function undoSendAction(sendId: string): Promise<ActionResult<MailUndoneSend | null>> {
  return run((userId) => undoSend(userId, sendId));
}

/** How a message sent from the composer went, with the reason said when it failed. */
export async function sendStatusAction(sendId: string): Promise<ActionResult<MailSendStatus>> {
  return run(async (userId) => {
    const status = sendStatus(userId, sendId);
    const t = await getTranslations("settings.email.errors");
    return { state: status.state, error: status.error ? t(status.error) : null };
  });
}

/** Saves what the composer holds as a draft in the mailbox's drafts folder, in place of its last save (see `composed`). */
export async function saveDraftAction(form: FormData): Promise<ActionResult<MailSavedDraft>> {
  return run(async (userId) => {
    const { draft, files } = composed(form);
    return saveDraft(userId, draft, files);
  });
}

/** Throws a draft away. */
export async function discardDraftAction(ref: MailDraftRef): Promise<ActionResult<null>> {
  return run((userId) => discardDraft(userId, ref));
}

/** A draft opened to write on again. */
export async function openDraftAction(id: string): Promise<ActionResult<MailDraftView>> {
  return run((userId) => openDraft(userId, id));
}
