/**
 * Backing up a workspace (lib/backup has the format): its rows, table by table as the database
 * holds them, and its uploaded files, in one ZIP that restore.ts brings back on any Leafdesk.
 *
 * Owners only, and not while the workspace has export turned off. The rows are read in one
 * read-only transaction, so they agree with each other, into temporary files; the archive is then
 * written from those and the storage, and the files removed once it has been sent.
 */
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { db } from "@/db";
import { aiChatFile, databaseProperty, file, page, user, workspace, workspaceAgent } from "@/db/schema";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  encodeValue,
  fileEntryPath,
  MANIFEST_PATH,
  TABLE_ENTRY_BYTES,
  tableEntryPath,
  type BackupManifest,
  type BackupPerson,
} from "@/lib/backup";
import { requireMembership } from "@/server/access";
import { aiTargetFor } from "@/server/ai";
import { readAiConfig } from "@/server/ai/config";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { refOf, storageResolver } from "@/server/storage/workspace";
import { exportAllowed } from "@/server/workspaces";
import journal from "../../../drizzle/meta/_journal.json";
import pkg from "../../../package.json";
import { backupTables, type BackupTable } from "./tables";

const MB = 1024 * 1024;
/** ZIPs without ZIP64 (fflate writes none) hold at most 65,535 entries and 4 GiB. */
const MAX_ENTRIES = 60_000;
const MAX_FILE_BYTES = 3.5 * 1024 * MB;
/** Rows read at a time. */
const BATCH = 500;

/** The last migration this Leafdesk has run: a backup says which schema its rows follow. */
export const SCHEMA_TAG = journal.entries[journal.entries.length - 1].tag;
export const SCHEMA_TAGS: readonly string[] = journal.entries.map((entry) => entry.tag);

export type BackupErrorCode =
  | "busy"
  | "disabled"
  | "tooLarge"
  | "invalid"
  | "newer"
  | "alreadyHere"
  | "notAllowed"
  | "quota"
  | "conflict";

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BackupError";
  }
}

// ---------------------------------------------------------------------------------------------
// One backup or restore at a time per person, a few per server

const running = new Set<string>();
const MAX_RUNNING = 2;

export const backupRunning = (userId: string) => running.has(userId);

/** Takes a slot for a backup or a restore by `userId`; returns the function that gives it back. */
export function startBackupWork(userId: string): () => void {
  if (running.has(userId) || running.size >= MAX_RUNNING) throw new BackupError("busy");
  running.add(userId);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running.delete(userId);
  };
}

// ---------------------------------------------------------------------------------------------
// Planning

export type BackupPlan = { workspaceId: string; name: string; files: number; fileBytes: number };

/** Checks that `userId` may back up the workspace and that it fits in one archive. */
export async function planBackup(userId: string, workspaceId: string): Promise<BackupPlan> {
  await requireMembership(userId, workspaceId, "owner");
  if (!(await exportAllowed(workspaceId))) throw new BackupError("disabled");
  const [ws] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  const [counts] = await db
    .select({ files: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${file.size}), 0)::bigint` })
    .from(file)
    // Files attached to AI chats stay out, like the chats (tables.ts).
    .where(and(eq(file.workspaceId, workspaceId), sql`${file.id} not in (select ${aiChatFile.fileId} from ${aiChatFile})`));
  const files = Number(counts.files);
  const fileBytes = Number(counts.bytes);
  if (files + backupTables().length * 64 > MAX_ENTRIES || fileBytes > MAX_FILE_BYTES) throw new BackupError("tooLarge");
  return { workspaceId, name: ws.name, files, fileBytes };
}

// ---------------------------------------------------------------------------------------------
// Reading the rows

/** The rows of a backup, written out, and what the archive needs besides them. */
export type BackupSnapshot = {
  dir: string;
  manifest: BackupManifest;
  /** The table entries in archive order: their path there and on disk. */
  entries: { path: string; file: string }[];
  files: { id: string; storageKey: string; storageId: string | null; storageObjectId: string | null; contentType: string; createdAt: Date }[];
};

/**
 * Reads the workspace's rows into a temporary folder and makes the manifest. Open pages are saved
 * first, so edits made a moment ago are in. Removes the folder itself when it fails; otherwise
 * `backupArchive` does once the archive has been sent.
 */
export async function snapshotWorkspace(plan: BackupPlan): Promise<BackupSnapshot> {
  const { workspaceId } = plan;
  try {
    await getCollab().saveOpen();
  } catch (error) {
    // No collab service (scripts): the database holds every page as it is.
    if (!(error instanceof Error && error.message.startsWith("Collab service unavailable"))) throw error;
  }
  const dir = await mkdtemp(join(tmpdir(), "leafdesk-backup-"));
  try {
    const tables = backupTables();
    const userIds = new Set<string>();
    const entries: BackupSnapshot["entries"] = [];
    const counts: BackupManifest["tables"] = [];
    let files: BackupSnapshot["files"] = [];

    await db.transaction(
      async (tx) => {
        // Person properties' values name people too, besides the columns that point at users.
        const personProperties = (
          await tx
            .select({ id: databaseProperty.id })
            .from(databaseProperty)
            .innerJoin(page, eq(page.id, databaseProperty.databaseId))
            .where(and(eq(page.workspaceId, workspaceId), eq(databaseProperty.type, "person")))
        ).map((p) => p.id);

        for (const t of tables) {
          const userColumns = t.foreignKeys.filter((key) => key.table === "user").flatMap((key) => key.columns);
          let part = 0;
          let lines: string[] = [];
          let bytes = 0;
          let rows = 0;
          const flush = async () => {
            if (!lines.length) return;
            part += 1;
            const path = tableEntryPath(t.name, part);
            const out = join(dir, `${t.name}-${part}.jsonl`);
            await writeFile(out, lines.join("\n") + "\n");
            entries.push({ path, file: out });
            lines = [];
            bytes = 0;
          };
          for (let offset = 0; ; offset += BATCH) {
            const batch = await selectBatch(tx, t, workspaceId, offset);
            for (const row of batch) {
              const encoded = encodeRow(t, row);
              for (const column of userColumns) if (typeof encoded[column] === "string") userIds.add(encoded[column] as string);
              if (t.name === "page") personValues(encoded.properties, personProperties, userIds);
              if (t.name === "file") {
                files.push({
                  id: row.id as string,
                  storageKey: row.storageKey as string,
                  storageId: (row.storageId as string | null) ?? null,
                  storageObjectId: (row.storageObjectId as string | null) ?? null,
                  contentType: row.contentType as string,
                  createdAt: row.createdAt as Date,
                });
              }
              const line = JSON.stringify(encoded);
              lines.push(line);
              bytes += line.length;
              rows += 1;
              if (bytes >= TABLE_ENTRY_BYTES) await flush();
            }
            if (batch.length < BATCH) break;
          }
          await flush();
          counts.push({ name: t.name, rows });
        }
        files = files.sort((a, b) => a.id.localeCompare(b.id));
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    const people = await peopleOf([...userIds]);
    // The model the workspace's chunks were made with: its own AI account's, or the server's.
    const ai = (await aiTargetFor(workspaceId))?.config ?? readAiConfig({});
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      schema: SCHEMA_TAG,
      app: pkg.version,
      createdAt: new Date().toISOString(),
      workspace: { id: workspaceId, name: plan.name },
      people,
      tables: counts,
      files: { count: files.length, bytes: plan.fileBytes },
      embeddings: ai.embeddings ? { model: ai.embeddings.model, dimensions: ai.embeddings.dimensions ?? null } : null,
    };
    return { dir, manifest, entries, files };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function selectBatch(tx: Tx, t: BackupTable, workspaceId: string, offset: number) {
  return tx
    .select()
    .from(t.table)
    .where(t.scope(workspaceId))
    .orderBy(...t.primaryKey.map((name) => asc(sql.identifier(name))))
    .limit(BATCH)
    .offset(offset) as Promise<Record<string, unknown>[]>;
}

/** A row as a backup holds it: by column name, JSON values, secrets of the old server left out. */
function encodeRow(t: BackupTable, row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const column of t.columns) encoded[column.name] = encodeValue(column.kind, row[column.key]);
  // Sealed with this server's key, so no use elsewhere; the invitation link is a secret.
  if (t.name === "workspace") encoded.invite_link_token = null;
  if (t.name === "connection") encoded.secrets = null;
  return encoded;
}

function personValues(properties: unknown, ids: string[], into: Set<string>) {
  if (!properties || typeof properties !== "object") return;
  for (const id of ids) {
    const value = (properties as Record<string, unknown>)[id];
    if (Array.isArray(value)) for (const v of value) if (typeof v === "string") into.add(v);
  }
}

async function peopleOf(ids: string[]): Promise<BackupPerson[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified, agentId: workspaceAgent.id })
    .from(user)
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, user.id))
    .where(inArray(user.id, ids));
  return rows
    .map((r) => ({ id: r.id, email: r.email, name: r.name, emailVerified: r.emailVerified, agent: r.agentId !== null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Writing the archive

/** Types that are compressed already: stored as they are rather than deflated again. */
const COMPRESSED = /^(image\/(png|jpeg|gif|webp|avif|heic)|video\/|audio\/|application\/(zip|pdf|gzip|x-7z-compressed|vnd\.openxmlformats))/;

/**
 * The archive of `snapshot`, as a stream the response sends: the manifest, the tables, the files.
 * Removes the snapshot's folder and runs `onDone` once it has been sent, failed or been cancelled.
 * A file missing from the storage fails the archive: a backup without it wouldn't be one.
 */
export function backupArchive(snapshot: BackupSnapshot, { onDone }: { onDone?: () => void } = {}): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.length) queue.push(chunk);
  });
  const storageOf = storageResolver();
  const now = new Date();

  async function* build(): AsyncGenerator<void> {
    const manifest = new ZipDeflate(MANIFEST_PATH, { level: 6 });
    manifest.mtime = now;
    zip.add(manifest);
    manifest.push(new TextEncoder().encode(JSON.stringify(snapshot.manifest, null, 2)), true);
    yield;

    for (const entry of snapshot.entries) {
      const out = new ZipDeflate(entry.path, { level: 6 });
      out.mtime = now;
      zip.add(out);
      for await (const chunk of createReadStream(entry.file)) {
        out.push(chunk as Uint8Array);
        yield;
      }
      out.push(new Uint8Array(0), true);
      yield;
    }

    for (const f of snapshot.files) {
      const body = await (await storageOf(f)).get(refOf(f));
      if (!body) throw new Error(`file ${f.id} is missing from the storage`);
      const out = COMPRESSED.test(f.contentType) ? new ZipPassThrough(fileEntryPath(f.id)) : new ZipDeflate(fileEntryPath(f.id), { level: 6 });
      out.mtime = now;
      zip.add(out);
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.push(value);
          yield;
        }
      } finally {
        reader.releaseLock();
        await body.cancel().catch(() => {});
      }
      out.push(new Uint8Array(0), true);
      yield;
    }
    zip.end();
  }

  const steps = build();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void rm(snapshot.dir, { recursive: true, force: true }).catch(() => {});
    onDone?.();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length) {
          const { done } = await steps.next();
          if (zipError) throw zipError;
          if (done) {
            while (queue.length) controller.enqueue(queue.shift()!);
            controller.close();
            finish();
            return;
          }
        }
        while (queue.length) controller.enqueue(queue.shift()!);
      } catch (error) {
        console.error("[backup] failed", error);
        controller.error(error);
        finish();
      }
    },
    async cancel() {
      await steps.return(undefined).catch(() => {});
      finish();
    },
  });
}

/** Records a backup in the audit log, as it is handed over. */
export async function recordBackup(userId: string, snapshot: BackupSnapshot) {
  const { manifest } = snapshot;
  await recordAudit({
    workspaceId: manifest.workspace.id,
    actorId: userId,
    action: "backup.created",
    target: { type: "workspace", id: manifest.workspace.id },
    details: { pages: manifest.tables.find((t) => t.name === "page")?.rows ?? 0, files: manifest.files.count },
  });
}

const STATUS: Record<BackupErrorCode, number> = {
  busy: 429,
  disabled: 403,
  notAllowed: 403,
  tooLarge: 413,
  quota: 413,
  invalid: 400,
  newer: 400,
  alreadyHere: 409,
  conflict: 409,
};

/** The HTTP response for a backup or restore problem: JSON the settings read. */
export function backupErrorResponse(error: BackupError) {
  return Response.json(
    { error: error.code, limit: error.code === "tooLarge" ? MAX_FILE_BYTES : null, message: error.message },
    { status: STATUS[error.code], headers: { "Cache-Control": "no-store" } },
  );
}
