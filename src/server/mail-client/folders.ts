import { and, eq, notInArray } from "drizzle-orm";
import type { ImapFlow, ListResponse } from "imapflow";
import { db } from "@/db";
import { mailFolder, type mailbox } from "@/db/schema";
import { folderRoles, listsFolder, MAIL_FOLDER_ROLES, MAX_MAIL_FOLDERS, type MailFolderRole } from "@/lib/mail-client";

type Box = typeof mailbox.$inferSelect;
export type FolderRow = typeof mailFolder.$inferSelect;

/** The folders in the order the Mail tab lists them: the inbox and the other roles first, then the owner's own by path. */
export function orderFolders<T extends { path: string; role: MailFolderRole | null }>(folders: T[]): T[] {
  const rank = (f: T) => (f.role ? MAIL_FOLDER_ROLES.indexOf(f.role) : MAIL_FOLDER_ROLES.length);
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

/**
 * Reads the mailbox's folder list into mail_folder: new folders are added, renamed or deleted ones
 * leave with their messages, and each keeps where reading it has got to. Counts come along where
 * the server lists them with their status in one go.
 */
export async function discoverFolders(client: ImapFlow, box: Box): Promise<FolderRow[]> {
  const withStatus = client.capabilities.has("LIST-STATUS");
  const listed: ListResponse[] = await client.list(withStatus ? { statusQuery: { messages: true, unseen: true } } : {});
  const shown = listed.filter(listsFolder);
  const roles = folderRoles(shown);
  const folders = orderFolders(shown.map((f) => ({ ...f, role: roles.get(f.path) ?? null }))).slice(0, MAX_MAIL_FOLDERS);

  const existing = await db.select().from(mailFolder).where(eq(mailFolder.mailboxId, box.id));
  const byPath = new Map(existing.map((f) => [f.path, f]));
  const out: FolderRow[] = [];
  for (const [position, folder] of folders.entries()) {
    const counts = folder.status ? { unseen: folder.status.unseen ?? 0, total: folder.status.messages ?? 0 } : {};
    const known = byPath.get(folder.path);
    const fields = { name: folder.name, role: folder.role, delimiter: folder.delimiter || null, position, ...counts };
    if (known) {
      const [row] = await db.update(mailFolder).set(fields).where(eq(mailFolder.id, known.id)).returning();
      out.push(row);
    } else {
      const [row] = await db
        .insert(mailFolder)
        .values({ mailboxId: box.id, path: folder.path, ...fields })
        .onConflictDoUpdate({ target: [mailFolder.mailboxId, mailFolder.path], set: fields })
        .returning();
      out.push(row);
    }
  }
  const kept = out.map((f) => f.id);
  await db.delete(mailFolder).where(and(eq(mailFolder.mailboxId, box.id), kept.length ? notInArray(mailFolder.id, kept) : undefined));
  return out;
}

/** Reads a folder's counts again; the folder must not be the one held open (RFC 3501 says not to STATUS it). */
export async function recount(client: ImapFlow, folder: FolderRow) {
  const status = await client.status(folder.path, { unseen: true, messages: true }).catch(() => null);
  if (status) await db.update(mailFolder).set({ unseen: status.unseen ?? folder.unseen, total: status.messages ?? folder.total }).where(eq(mailFolder.id, folder.id));
}

/** Makes a folder for a role the server has none for (an archive, drafts), and lists it. */
export async function makeFolder(client: ImapFlow, box: Box, name: string, role: MailFolderRole): Promise<FolderRow> {
  const made = await client.mailboxCreate(name);
  const [row] = await db
    .insert(mailFolder)
    .values({ mailboxId: box.id, path: made.path, name, role, position: MAIL_FOLDER_ROLES.indexOf(role) })
    .onConflictDoUpdate({ target: [mailFolder.mailboxId, mailFolder.path], set: { role } })
    .returning();
  return row;
}
