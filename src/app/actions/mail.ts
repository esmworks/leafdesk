"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { MailAction, MailBody, MailboxTabView, MailDraftInput, MailFolderView, MailThreadPage, MailThreadView } from "@/lib/mail-client";
import { AccessError } from "@/server/access";
import { getThread, listMailboxes, listThreads, openMailbox, readBody, refreshFolder, refreshMailbox } from "@/server/mail-client/read";
import { mailAction, sendMail } from "@/server/mail-client/write";
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

export async function refreshMailboxAction(mailboxId: string): Promise<ActionResult<MailboxTabView>> {
  return run((userId) => refreshMailbox(userId, mailboxId));
}

export async function mailActionAction(input: { mailboxId: string; folderId: string; threadIds: string[]; action: MailAction }): Promise<ActionResult<null>> {
  return run(async (userId) => {
    await mailAction(userId, input);
    return null;
  });
}

/** Sends a message: `draft` as JSON under "draft", the files under "file". */
export async function sendMailAction(form: FormData): Promise<ActionResult<{ messageId: string }>> {
  return run(async (userId) => {
    let draft: MailDraftInput;
    try {
      draft = JSON.parse(String(form.get("draft") ?? ""));
    } catch {
      throw new RowMailError("invalid");
    }
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    return sendMail(userId, draft, files);
  });
}
