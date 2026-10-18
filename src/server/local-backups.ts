/**
 * Backups of Leafdesk on this computer (LEAFDESK_LOCAL_MODE): the database lives in the desktop
 * app's profile, so the computer's account gets a backup of each workspace it owns (server/backup,
 * the format any Leafdesk restores) in a folder of its choosing, LEAFDESK_BACKUP_DIR — a synced one
 * such as iCloud Drive or Dropbox keeps a copy off the computer. One is made when the last is a
 * day old (checked a minute after the server starts and every hour), or when the app asks, and the
 * newest KEEP of each workspace are kept.
 *
 * The desktop app (desktop/src/local-server.ts) talks to this over the server's IPC channel:
 * `{ backup: "now", id }` makes one and is answered `{ backup: result, id }`; `{ backupFolder }`
 * moves the folder; a backup made on schedule is reported as `{ backup: result }`.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { env } from "@/lib/env";
import { BackupError, backupArchive, planBackup, recordBackup, snapshotWorkspace, startBackupWork } from "@/server/backup/export";
import { listWorkspaces } from "@/server/workspaces";

/** How many backups of each workspace are kept. */
export const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export type LocalBackupResult = {
  folder: string;
  /** The backups written, by full path. */
  files: string[];
  /** What went wrong, by workspace (or for all of them); none when everything was backed up. */
  errors: string[];
};

/** The part of a file name that tells one workspace's backups from another's: its id's start. */
const tagOf = (workspaceId: string) => `[${workspaceId.slice(0, 8)}]`;
const BACKUP_NAME = /\[[0-9a-f]{8}\]\.zip$/;

/**
 * `<workspace name> <date> <time> [<id start>].zip`, in local time to the second; the name without
 * what file systems refuse.
 */
export function backupFileName(name: string, workspaceId: string, at: Date): string {
  const safe =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 80)
      .trim() || "Workspace";
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
  return `${safe} ${stamp} ${tagOf(workspaceId)}.zip`;
}

/** The backups in `folder` (of one workspace, or all), newest first. */
export function backupsIn(folder: string, workspaceId?: string): { file: string; time: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => (workspaceId ? name.endsWith(` ${tagOf(workspaceId)}.zip`) : BACKUP_NAME.test(name)))
    .map((name) => ({ file: path.join(folder, name), time: fs.statSync(path.join(folder, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

/** Removes a workspace's backups beyond the newest `keep`. */
export function pruneBackups(folder: string, workspaceId: string, keep = KEEP) {
  for (const { file } of backupsIn(folder, workspaceId).slice(keep)) fs.rmSync(file, { force: true });
}

/** Backs up each workspace `userId` owns into `folder`, written whole before it gets its name. */
export async function backUpWorkspaces(userId: string, folder: string, now = new Date()): Promise<LocalBackupResult> {
  const result: LocalBackupResult = { folder, files: [], errors: [] };
  fs.mkdirSync(folder, { recursive: true });
  // Left by a server stopped while it wrote.
  for (const name of fs.readdirSync(folder)) if (name.endsWith(".zip.partial")) fs.rmSync(path.join(folder, name), { force: true });

  for (const ws of (await listWorkspaces(userId)).filter((w) => w.role === "owner")) {
    const target = path.join(folder, backupFileName(ws.name, ws.id, now));
    const partial = `${target}.partial`;
    let release: (() => void) | null = null;
    try {
      release = startBackupWork(userId);
      const snapshot = await snapshotWorkspace(await planBackup(userId, ws.id));
      await pipeline(Readable.fromWeb(backupArchive(snapshot) as NodeReadableStream<Uint8Array>), fs.createWriteStream(partial));
      fs.renameSync(partial, target);
      await recordBackup(userId, snapshot);
      result.files.push(target);
      pruneBackups(folder, ws.id);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      // The workspace's owner turned exporting off (its settings): no backup is what they asked for.
      if (error instanceof BackupError && error.code === "disabled") continue;
      result.errors.push(`${ws.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release?.();
    }
  }
  return result;
}

let folder = process.env.LEAFDESK_BACKUP_DIR?.trim() || undefined;
let running: Promise<LocalBackupResult> | null = null;

/** Backs up now, or joins the backup already under way. */
export function backUpNow(): Promise<LocalBackupResult> {
  running ??= (async (): Promise<LocalBackupResult> => {
    const into = folder;
    if (!into) return { folder: "", files: [], errors: ["No backup folder"] };
    try {
      const email = process.env.LEAFDESK_LOCAL_EMAIL;
      const [account] = email ? await db.select({ id: user.id }).from(user).where(eq(user.email, email)) : [];
      if (!account) return { folder: into, files: [], errors: ["This computer's account isn't there"] };
      return await backUpWorkspaces(account.id, into);
    } catch (error) {
      return { folder: into, files: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
  })().finally(() => (running = null));
  return running;
}

/** Whether the newest backup in the folder is a day old, or there is none. */
function due(now = Date.now()) {
  if (!folder) return false;
  const [newest] = backupsIn(folder);
  return !newest || now - newest.time >= DAY_MS;
}

/** In local mode with a backup folder: backs up on schedule, and on the desktop app's request. */
export function startLocalBackups() {
  if (!env.localMode) return;
  const report = (result: LocalBackupResult, id?: unknown) => {
    if (result.errors.length) console.error(`[backup] ${result.errors.join("; ")}`);
    else if (result.files.length) console.log(`[backup] ${result.files.length} written to ${result.folder}`);
    process.send?.({ backup: result, ...(id !== undefined && { id }) });
  };
  const check = () => {
    if (due()) void backUpNow().then((result) => report(result));
  };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const { backup, backupFolder, id } = message as { backup?: unknown; backupFolder?: unknown; id?: unknown };
    if (typeof backupFolder === "string" && backupFolder.trim()) folder = backupFolder.trim();
    if (backup === "now") void backUpNow().then((result) => report(result, id));
  });
}
