"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { MailboxView, MailSettingsView } from "@/lib/mail";
import { AccessError } from "@/server/access";
import { hideRowEmail, listRowEmails, type RowEmailList } from "@/server/row-mail/list";
import { queueRowEmail, sendSoon, type RowEmailDraft } from "@/server/row-mail/send";
import {
  connectMailbox,
  disconnectMailbox,
  getMailSettings,
  RowMailError,
  setMailboxSending,
  setMailDatabases,
  type MailboxInput,
} from "@/server/row-mail/settings";
import { requireUserId } from "@/server/session";

// Email on rows (see server/row-mail): owners pick the databases mail lands on, members connect
// their own mailbox, and people who may edit a row write from it. Expected failures come back
// translated: Next.js hides thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>, refresh?: string): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    const data = await fn(userId);
    if (refresh) revalidatePath(refresh);
    return { ok: true, data };
  } catch (error) {
    const t = await getTranslations("settings.email.errors");
    if (error instanceof RowMailError) return { ok: false, error: t(error.code), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    console.error("[row mail action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

export async function getMailSettingsAction(workspaceId: string): Promise<ActionResult<MailSettingsView>> {
  return run((userId) => getMailSettings(userId, workspaceId));
}

export async function setMailDatabasesAction(
  workspaceId: string,
  entries: { databaseId: string; propertyIds: string[] }[],
): Promise<ActionResult<MailSettingsView>> {
  return run(async (userId) => {
    await setMailDatabases(userId, workspaceId, entries);
    return getMailSettings(userId, workspaceId);
  });
}

export async function connectMailboxAction(workspaceId: string, input: MailboxInput): Promise<ActionResult<MailboxView>> {
  return run((userId) => connectMailbox(userId, workspaceId, input));
}

/** How follow-ups send from the member's mailbox: a daily limit and the time zone of their send windows. */
export async function setMailboxSendingAction(workspaceId: string, input: { dailyLimit: number; timeZone: string }): Promise<ActionResult<MailboxView>> {
  return run((userId) => setMailboxSending(userId, workspaceId, input));
}

export async function disconnectMailboxAction(workspaceId: string): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await disconnectMailbox(userId, workspaceId);
    return undefined;
  });
}

/** A row's messages, newest first (`before`: older than that time); null when the viewer may not read them. */
export async function listRowEmailsAction(rowId: string, before?: string | null): Promise<ActionResult<RowEmailList | null>> {
  return run((userId) => listRowEmails(userId, rowId, before));
}

/** Queues a message from the viewer's mailbox on the row and sends it right away. */
export async function sendRowEmailAction(rowId: string, draft: RowEmailDraft): Promise<ActionResult<string>> {
  return run(async (userId) => {
    const id = await queueRowEmail(userId, rowId, {
      to: draft?.to,
      cc: draft?.cc,
      subject: draft?.subject,
      text: draft?.text,
      replyTo: draft?.replyTo ?? null,
    });
    sendSoon();
    return id;
  });
}

export async function hideRowEmailAction(rowEmailId: string): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await hideRowEmail(userId, rowEmailId);
    return undefined;
  });
}
