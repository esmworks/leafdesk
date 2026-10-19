"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { isInstanceAdmin } from "@/lib/instance-admin";
import type { S3StorageInput, StorageAccountsView, StorageSettingsView } from "@/lib/workspace-storage";
import { AccessError } from "@/server/access";
import {
  attachAccount,
  beginStorageOAuth,
  connectS3Account,
  disconnectAccount,
  getStorageAccounts,
  renameAccount,
  retestAccount,
  setDefaultAccount,
  testS3Account,
} from "@/server/storage/accounts";
import { dismissMove, retryMove, startManualMove } from "@/server/storage/moves";
import { disconnectStorage, getStorageSettings, retestStorage, StorageSettingsError } from "@/server/storage/settings";
import { getSession } from "@/server/session";

// A workspace's Settings > Storage (see server/storage/settings.ts), for owners, and the storage
// accounts of one's own account (server/storage/accounts.ts). Expected failures come back
// translated: Next.js hides thrown messages in production.

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function run<T>(fn: (userId: string, session: Session) => Promise<T>): Promise<ActionResult<T>> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  try {
    return { ok: true, data: await fn(session.user.id, session) };
  } catch (error) {
    const t = await getTranslations("settings.storage.errors");
    if (error instanceof StorageSettingsError) {
      return { ok: false, error: t(error.code, { message: error.detail ?? "", workspace: error.detail ?? "" }), code: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    console.error("[storage action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** The workspace's storage settings again, after a change. */
const settingsOf = (userId: string, session: Session, workspaceId: string) => getStorageSettings(userId, workspaceId, { isAdmin: isInstanceAdmin(session.user) });
const accountsOf = (userId: string, session: Session) => getStorageAccounts(userId, { isAdmin: isInstanceAdmin(session.user) });

// ---------------------------------------------------------------------- One's own storage accounts

/** One's storage accounts as they are now. */
export async function getStorageAccountsAction(): Promise<ActionResult<StorageAccountsView>> {
  return run((userId, session) => accountsOf(userId, session));
}

/** Tries an S3-compatible bucket with a test object, without keeping it. */
export async function testS3AccountAction(input: S3StorageInput): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await testS3Account(userId, input);
    return undefined;
  });
}

/** Connects an S3-compatible bucket to one's account; with `workspaceId`, that workspace starts using it. */
export async function connectS3AccountAction(input: S3StorageInput & { label?: string }, workspaceId?: string): Promise<ActionResult<StorageAccountsView>> {
  return run(async (userId, session) => {
    await connectS3Account(userId, input, workspaceId);
    return accountsOf(userId, session);
  });
}

/** Begins signing in to Google Drive or Dropbox: the address to send the browser to. */
export async function beginStorageOAuthAction(kind: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return run((userId) => beginStorageOAuth(userId, kind, workspaceId ?? null));
}

export async function retestAccountAction(accountId: string): Promise<ActionResult<StorageAccountsView>> {
  return run(async (userId, session) => {
    await retestAccount(userId, accountId);
    return accountsOf(userId, session);
  });
}

export async function renameAccountAction(accountId: string, label: string): Promise<ActionResult<StorageAccountsView>> {
  return run(async (userId, session) => {
    await renameAccount(userId, accountId, label);
    return accountsOf(userId, session);
  });
}

export async function setDefaultAccountAction(accountId: string, isDefault: boolean): Promise<ActionResult<StorageAccountsView>> {
  return run(async (userId, session) => {
    await setDefaultAccount(userId, accountId, isDefault);
    return accountsOf(userId, session);
  });
}

export async function disconnectAccountAction(accountId: string): Promise<ActionResult<StorageAccountsView>> {
  return run(async (userId, session) => {
    await disconnectAccount(userId, accountId);
    return accountsOf(userId, session);
  });
}

// ---------------------------------------------------------------------- A workspace's storage

/** The workspace starts keeping new uploads in one of one's storage accounts. */
export async function attachStorageAccountAction(workspaceId: string, accountId: string): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await attachAccount(userId, workspaceId, accountId);
    return settingsOf(userId, session, workspaceId);
  });
}

export async function retestStorageAction(workspaceId: string): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await retestStorage(userId, workspaceId);
    return settingsOf(userId, session, workspaceId);
  });
}

export async function disconnectStorageAction(workspaceId: string): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await disconnectStorage(userId, workspaceId);
    return settingsOf(userId, session, workspaceId);
  });
}

/** Moves every file of the workspace to one of one's storage accounts, or to the server's storage. */
export async function moveFilesAction(workspaceId: string, to: { server: true } | { accountId: string }): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await startManualMove(userId, workspaceId, to);
    return settingsOf(userId, session, workspaceId);
  });
}

export async function retryMoveAction(workspaceId: string, moveId: string): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await retryMove(userId, workspaceId, moveId);
    return settingsOf(userId, session, workspaceId);
  });
}

export async function dismissMoveAction(workspaceId: string, moveId: string): Promise<ActionResult<StorageSettingsView>> {
  return run(async (userId, session) => {
    await dismissMove(userId, workspaceId, moveId);
    return settingsOf(userId, session, workspaceId);
  });
}

/** The workspace's storage settings as they are now (Settings > Storage refreshes while files move). */
export async function storageSettingsAction(workspaceId: string): Promise<ActionResult<StorageSettingsView>> {
  return run((userId, session) => settingsOf(userId, session, workspaceId));
}
