import { Readable } from "node:stream";
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { file, storageAccount, storageDeletion, storageMove, workspace, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import { sameLocation, type MoveDestinationView, type MoveReason, type StorageMoveView } from "@/lib/workspace-storage";
import { ownersInOrder, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { drainStorageDeletions, removeStored } from "@/server/files";
import { startSweep } from "@/server/sweep";
import { lockWorkspaceStorage, makeCurrent, placeFor, refuseDuringMove } from "./accounts";
import { StorageError, type StorageDriver } from "./driver";
import { StorageSettingsError } from "./errors";
import { instanceStorage, uploadLimits } from "./index";
import { currentTarget, loadTargets, probeStorage, refOf, removeRetiredStorage, storageOf, targetLocation, type StorageTarget } from "./workspace";

/**
 * Moving a workspace's files to another storage, in the background (`storage_move`), so they
 * outlive the storage they are in: when the person whose storage it is leaves the workspace, is
 * removed from it, deletes their Leafdesk account or disconnects the storage (`planMovesAway`), or
 * when an owner asks (`startManualMove`).
 *
 * Where they may go: another owner's default storage account, or the server's own storage, but only
 * when that is S3 (never the server's disk: workspaces' files mustn't fill it) and the files fit the
 * workspace's quota there (UPLOAD_WORKSPACE_QUOTA_MB). The destination takes the workspace's new
 * uploads from the start. Each file is streamed across with the drivers and its row pointed at the
 * copy right away, a few at a time, so every file stays readable throughout; the old copies are
 * queued for deletion held by the move, and deleted only once every file is across. A move picks up
 * where it was after a restart, and one with files it couldn't copy can be tried again.
 */

/** Files per round: each round's rows are written, and the move's lease renewed, before the next. */
const BATCH = 20;
/** How long a worker holds a move before another server may take it over. */
const LEASE_MS = 5 * 60_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select">;
export type MoveDestination = { toServer: true } | { toAccountId: string };

// ---------------------------------------------------------------------- Where files may go

/** The server's storage, for a move: whether it is S3, and how much more of the workspace's files it would take. */
export type ServerRoom = { s3: boolean; room: number };

export async function serverRoom(workspaceId: string, reader: Reader = db): Promise<ServerRoom> {
  const quota = uploadLimits().workspaceQuotaBytes;
  const [row] = await reader
    .select({ used: sql<string>`coalesce(sum(${file.size}), 0)` })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), isNull(file.storageId)));
  return { s3: instanceStorage().kind === "s3", room: quota - Number(row?.used ?? 0) };
}

/**
 * Where a workspace's files go when they must leave a storage: the first owner's (longest-standing
 * first) default storage account that works, leaving out `excludeUserId` (the person going) and the
 * accounts the files are leaving; else the server's storage, when it is S3 and has room for `bytes`;
 * else nowhere (null).
 */
export function pickDestination(input: {
  owners: { userId: string; defaultAccount: { id: string; status: string } | null }[];
  excludeUserId?: string | null;
  excludeAccountIds?: readonly string[];
  server: ServerRoom;
  bytes: number;
}): MoveDestination | null {
  for (const owner of input.owners) {
    if (owner.userId === input.excludeUserId) continue;
    const account = owner.defaultAccount;
    if (account && account.status === "active" && !input.excludeAccountIds?.includes(account.id)) return { toAccountId: account.id };
  }
  if (input.server.s3 && input.bytes <= input.server.room) return { toServer: true };
  return null;
}

/** The workspace's owners, longest-standing first, each with their default storage account. */
async function ownersWithDefaults(reader: Reader, workspaceId: string) {
  const owners = await ownersInOrder(reader, workspaceId);
  const defaults = owners.length
    ? await reader
        .select({ id: storageAccount.id, userId: storageAccount.userId, status: storageAccount.status })
        .from(storageAccount)
        .where(and(inArray(storageAccount.userId, owners), eq(storageAccount.isDefault, true), ne(storageAccount.status, "disconnected")))
    : [];
  return owners.map((userId) => {
    const account = defaults.find((d) => d.userId === userId);
    return { userId, defaultAccount: account ? { id: account.id, status: account.status } : null };
  });
}

/** Bytes of the workspace's files in these places. */
async function bytesIn(reader: Reader, workspaceId: string, storageIds: string[]) {
  if (!storageIds.length) return 0;
  const [row] = await reader
    .select({ bytes: sql<string>`coalesce(sum(${file.size}), 0)` })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), inArray(file.storageId, storageIds)));
  return Number(row?.bytes ?? 0);
}

// ---------------------------------------------------------------------- Planning

const OPEN = ["queued", "running"] as const;

/**
 * Inside the transaction that makes someone's storage go away from workspaces (they leave or are
 * removed, delete their Leafdesk account, or disconnect a storage account): queues moving the files
 * of every workspace concerned out of it, to where `pickDestination` says. Nothing reaches out to a
 * storage here: the moves find their destination's place and copy the files once the transaction is
 * done (`kickMoves`). Meanwhile the storage keeps serving the files, and new uploads, as before.
 *
 * Whose storage: `userId`'s accounts (in `workspaceIds`, when given), or the accounts `accountIds`.
 * A workspace with nowhere for the files to go: with `mode` "refuse" the change is refused
 * (StorageSettingsError `noDestination`, naming it); with "block" it goes ahead and owners see a
 * blocked move in Settings > Storage, the files staying readable from the storage meanwhile.
 * Returns how many moves were queued.
 */
export async function planMovesAway(
  tx: Tx | typeof db,
  input: {
    userId?: string;
    accountIds?: string[];
    workspaceIds?: string[];
    reason: MoveReason;
    actorId: string | null;
    /** "preview": writes nothing, refuses nothing, only says which workspaces would move or be stuck. */
    mode: "refuse" | "block" | "preview";
  },
): Promise<{ queued: number; moving: string[]; stuck: string[] }> {
  const whose = input.accountIds?.length ? inArray(storageAccount.id, input.accountIds) : input.userId ? eq(storageAccount.userId, input.userId) : undefined;
  const outcome = { queued: 0, moving: [] as string[], stuck: [] as string[] };
  if (!whose) return outcome;
  const places = await tx
    .select({ id: workspaceStorage.id, workspaceId: workspaceStorage.workspaceId, accountId: storageAccount.id, status: workspaceStorage.status })
    .from(workspaceStorage)
    .innerJoin(storageAccount, eq(storageAccount.id, workspaceStorage.storageAccountId))
    .where(
      and(
        whose,
        input.workspaceIds ? inArray(workspaceStorage.workspaceId, input.workspaceIds.length ? input.workspaceIds : [""]) : sql`${workspaceStorage.workspaceId} is not null`,
        or(ne(workspaceStorage.status, "disconnected"), sql`exists (select 1 from ${file} f where f.storage_id = ${workspaceStorage.id})`),
      ),
    );
  const byWorkspace = new Map<string, { ids: string[]; accountIds: string[] }>();
  for (const place of places) {
    const entry = byWorkspace.get(place.workspaceId!) ?? { ids: [], accountIds: [] };
    entry.ids.push(place.id);
    entry.accountIds.push(place.accountId);
    byWorkspace.set(place.workspaceId!, entry);
  }
  const preview = input.mode === "preview";
  for (const [workspaceId, { ids, accountIds }] of byWorkspace) {
    if (!preview) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:workspace-storage:${workspaceId}`}))`);
    const [open] = await tx
      .select()
      .from(storageMove)
      .where(and(eq(storageMove.workspaceId, workspaceId), inArray(storageMove.status, OPEN)));
    if (open) {
      // A move under way to somewhere that stays takes these files along too.
      if (!open.toAccountId || !accountIds.includes(open.toAccountId)) {
        outcome.moving.push(workspaceId);
        if (open.fromStorageIds && !preview) {
          await tx
            .update(storageMove)
            .set({ fromStorageIds: [...new Set([...open.fromStorageIds, ...ids])] })
            .where(eq(storageMove.id, open.id));
        }
        continue;
      }
      if (input.mode === "refuse") throw new StorageSettingsError("moveInProgress", await nameOf(tx, workspaceId));
      outcome.stuck.push(workspaceId);
      continue;
    }
    const bytes = await bytesIn(tx, workspaceId, ids);
    const destination = pickDestination({
      owners: await ownersWithDefaults(tx, workspaceId),
      excludeUserId: input.userId ?? null,
      excludeAccountIds: accountIds,
      server: await serverRoom(workspaceId, tx),
      bytes,
    });
    const files = await countIn(tx, workspaceId, ids);
    if (!files && destination === null) {
      // Nothing stored there yet: the workspace just stops uploading there.
      if (!preview) await tx.update(workspaceStorage).set({ status: "disconnected" }).where(inArray(workspaceStorage.id, ids));
      continue;
    }
    if (!destination && input.mode === "refuse") throw new StorageSettingsError("noDestination", await nameOf(tx, workspaceId));
    (destination ? outcome.moving : outcome.stuck).push(workspaceId);
    if (preview) continue;
    await tx.insert(storageMove).values({
      workspaceId,
      fromStorageIds: ids,
      toServer: destination !== null && "toServer" in destination,
      toAccountId: destination && "toAccountId" in destination ? destination.toAccountId : null,
      status: destination ? "queued" : "blocked",
      reason: input.reason,
      leaverId: input.reason === "disconnected" ? null : (input.userId ?? null),
      files,
      startedBy: input.actorId,
      lastError: destination ? null : "No owner has storage the files may go to, and the server's storage can't take them",
    });
    if (destination) outcome.queued++;
  }
  return outcome;
}

async function nameOf(reader: Reader, workspaceId: string) {
  const [row] = await reader.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  return row?.name ?? workspaceId;
}

async function countIn(reader: Reader, workspaceId: string, storageIds: string[]) {
  const [row] = await reader
    .select({ n: sql<number>`count(*)::int` })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), inArray(file.storageId, storageIds)));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------- Owners' own moves

/** Where an owner may move the workspace's files now: their own storage accounts, and the server's storage when it may take them. */
export async function moveDestinations(userId: string, workspaceId: string): Promise<MoveDestinationView[]> {
  const [current, room, outside] = await Promise.all([currentTarget(workspaceId), serverRoom(workspaceId), bytesOutsideServer(workspaceId)]);
  const destinations: MoveDestinationView[] = [];
  if (env.ownStorageEnabled) {
    const mine = await db
      .select()
      .from(storageAccount)
      .where(and(eq(storageAccount.userId, userId), eq(storageAccount.status, "active")))
      .orderBy(asc(storageAccount.createdAt));
    for (const account of mine) {
      if (current?.storageAccountId === account.id && !(await filesElsewhere(workspaceId, current.id))) continue;
      destinations.push({ kind: account.kind, accountId: account.id, label: account.label });
    }
  }
  if (room.s3 && outside > 0 && outside <= room.room) destinations.push({ kind: "server" });
  return destinations;
}

async function bytesOutsideServer(workspaceId: string) {
  const [row] = await db
    .select({ bytes: sql<string>`coalesce(sum(${file.size}), 0)` })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), sql`${file.storageId} is not null`));
  return Number(row?.bytes ?? 0);
}

async function filesElsewhere(workspaceId: string, storageId: string) {
  const [row] = await db
    .select({ id: file.id })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), or(isNull(file.storageId), ne(file.storageId, storageId))))
    .limit(1);
  return Boolean(row);
}

/**
 * An owner moves every file of the workspace to one of their storage accounts, or to the server's
 * storage (when it is S3 and the files fit): new uploads go there from then on.
 */
export async function startManualMove(userId: string, workspaceId: string, to: { server: true } | { accountId: string }): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  await refuseDuringMove(workspaceId);
  let label = "the server's storage";
  if ("accountId" in to) {
    // Moving into storage of one's own is a new connection for the workspace.
    if (!env.ownStorageEnabled) throw new StorageSettingsError("disabled");
    const [account] = await db
      .select()
      .from(storageAccount)
      .where(and(eq(storageAccount.id, to.accountId), eq(storageAccount.userId, userId)));
    if (!account) throw new StorageSettingsError("noAccount");
    if (account.status === "disconnected") throw new StorageSettingsError("accountDisconnected");
    label = account.label;
  } else {
    const room = await serverRoom(workspaceId);
    if (!room.s3 || (await bytesOutsideServer(workspaceId)) > room.room) throw new StorageSettingsError("serverRefused");
  }
  await db.transaction(async (tx) => {
    await lockWorkspaceStorage(tx, workspaceId);
    await refuseDuringMove(workspaceId, tx);
    await tx.insert(storageMove).values({
      workspaceId,
      fromStorageIds: null,
      toServer: "server" in to,
      toAccountId: "accountId" in to ? to.accountId : null,
      reason: "manual",
      startedBy: userId,
    });
  });
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "storage.moved",
    target: { type: "storage", id: workspaceId, label },
  });
  kickMoves();
}

/** Tries a move that couldn't copy every file again (or a blocked one, now that it may go somewhere). */
export async function retryMove(userId: string, workspaceId: string, moveId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const [move] = await db
    .select()
    .from(storageMove)
    .where(and(eq(storageMove.id, moveId), eq(storageMove.workspaceId, workspaceId)));
  if (!move || (move.status !== "failed" && move.status !== "blocked")) throw new StorageSettingsError("noMove");
  await refuseDuringMove(workspaceId);
  let destination: MoveDestination | null = move.toServer ? { toServer: true } : move.toAccountId ? { toAccountId: move.toAccountId } : null;
  if (!destination) {
    // Blocked: somewhere may have turned up since (an owner's default storage, room on the server).
    const ids = move.fromStorageIds ?? [];
    destination = pickDestination({
      owners: await ownersWithDefaults(db, workspaceId),
      excludeUserId: move.leaverId,
      excludeAccountIds: (await loadTargets(inArray(workspaceStorage.id, ids.length ? ids : [""]))).map((t) => t.storageAccountId),
      server: await serverRoom(workspaceId),
      bytes: await bytesIn(db, workspaceId, ids),
    });
    if (!destination) throw new StorageSettingsError("noDestination", await nameOf(db, workspaceId));
  }
  await db
    .update(storageMove)
    .set({
      status: "queued",
      toServer: "toServer" in destination,
      toAccountId: "toAccountId" in destination ? destination.toAccountId : null,
      lastError: null,
      failed: 0,
      dismissed: false,
      finishedAt: null,
      lockedUntil: null,
    })
    .where(and(eq(storageMove.id, move.id), inArray(storageMove.status, ["failed", "blocked"])));
  kickMoves();
}

/** Closes the notice of a finished, failed or blocked move in Settings > Storage. */
export async function dismissMove(userId: string, workspaceId: string, moveId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  await db
    .update(storageMove)
    .set({ dismissed: true })
    .where(and(eq(storageMove.id, moveId), eq(storageMove.workspaceId, workspaceId), notInArray(storageMove.status, [...OPEN])));
}

/** The workspace's latest move, for Settings > Storage: under way, or finished and not dismissed yet. */
export async function latestMove(workspaceId: string): Promise<StorageMoveView | null> {
  const [move] = await db
    .select({ move: storageMove, label: storageAccount.label, kind: storageAccount.kind })
    .from(storageMove)
    .leftJoin(storageAccount, eq(storageAccount.id, storageMove.toAccountId))
    .where(and(eq(storageMove.workspaceId, workspaceId), eq(storageMove.dismissed, false)))
    .orderBy(desc(storageMove.createdAt))
    .limit(1);
  if (!move) return null;
  const m = move.move;
  return {
    id: m.id,
    status: m.status,
    reason: m.reason,
    destination: m.toServer || !move.kind ? { kind: "server" } : { kind: move.kind, label: move.label ?? "" },
    files: m.files,
    moved: m.moved,
    failed: m.failed,
    lastError: m.lastError,
    createdAt: m.createdAt.toISOString(),
    finishedAt: m.finishedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------- Running them

/** Takes the next move that is due (queued, or running on a server whose lease ran out). */
async function claim(): Promise<typeof storageMove.$inferSelect | null> {
  const rows = await db.execute<{ id: string }>(sql`
    update ${storageMove} set status = 'running', locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval, updated_at = now()
    where id = (
      select id from ${storageMove}
      where status in ('queued', 'running') and (locked_until is null or locked_until < now())
      order by created_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [move] = await db.select().from(storageMove).where(eq(storageMove.id, id));
  return move ?? null;
}

/** Moves every move that is due, one after the other. Returns how many finished. */
export async function runDueMoves(): Promise<number> {
  let finished = 0;
  for (;;) {
    const move = await claim();
    if (!move) return finished;
    if (await runMove(move)) finished++;
  }
}

type Destination = { storageId: string | null; driver: StorageDriver; target: StorageTarget | null };

/**
 * The move's destination, made ready: its place in the storage account made (a Drive folder) and
 * tried, and made where the workspace's new uploads go; or, for the server's storage, the
 * workspace's own storage disconnected so new uploads go to the server's.
 */
async function prepare(move: typeof storageMove.$inferSelect): Promise<Destination> {
  if (move.toServer) {
    if (instanceStorage().kind !== "s3") throw new StorageError("The server's storage isn't S3: workspaces' files don't move onto its disk");
    await db.transaction(async (tx) => {
      await lockWorkspaceStorage(tx, move.workspaceId);
      await tx
        .update(workspaceStorage)
        .set({ status: "disconnected" })
        .where(
          and(
            eq(workspaceStorage.workspaceId, move.workspaceId),
            ne(workspaceStorage.status, "disconnected"),
            move.fromStorageIds ? inArray(workspaceStorage.id, move.fromStorageIds) : undefined,
          ),
        );
    });
    return { storageId: null, driver: instanceStorage(), target: null };
  }
  if (move.toStorageId) {
    const [target] = await loadTargets(eq(workspaceStorage.id, move.toStorageId));
    if (target) return { storageId: target.id, driver: await storageOf({ storageId: target.id }), target };
  }
  if (!move.toAccountId) throw new StorageError("The storage the files were to go to was disconnected");
  const [account] = await db.select().from(storageAccount).where(eq(storageAccount.id, move.toAccountId));
  if (!account || account.status === "disconnected" || !account.userId) throw new StorageError("The storage the files were to go to was disconnected");
  const made = await placeFor(account, move.workspaceId);
  const { id } = await db.transaction(async (tx) => {
    await lockWorkspaceStorage(tx, move.workspaceId);
    const result = await makeCurrent(tx, { workspaceId: move.workspaceId, account: made.account, place: made.place, userId: move.startedBy });
    await tx.update(storageMove).set({ toStorageId: result.id }).where(eq(storageMove.id, move.id));
    return result;
  });
  const [target] = await loadTargets(eq(workspaceStorage.id, id));
  const driver = await storageOf({ storageId: id });
  await probeStorage(driver, move.workspaceId);
  return { storageId: id, driver, target };
}

/** Which of the workspace's files the move takes: those in its sources, or every one not at the destination. */
function movable(move: typeof storageMove.$inferSelect, destinationId: string | null): SQL {
  const notThere = destinationId ? or(isNull(file.storageId), ne(file.storageId, destinationId)) : sql`${file.storageId} is not null`;
  const from = move.fromStorageIds ? inArray(file.storageId, move.fromStorageIds.length ? move.fromStorageIds : [""]) : undefined;
  return and(eq(file.workspaceId, move.workspaceId), notThere, from)!;
}

/** Runs one move as far as it goes. Returns whether it finished. */
async function runMove(move: typeof storageMove.$inferSelect): Promise<boolean> {
  try {
    const destination = await prepare(move);
    const where = movable(move, destination.storageId);
    const [{ remaining }] = await db.select({ remaining: sql<number>`count(*)::int` }).from(file).where(where);
    await db
      .update(storageMove)
      .set({ files: move.moved + Number(remaining), failed: 0, lastError: null })
      .where(eq(storageMove.id, move.id));
    const sources = new Map<string | null, Promise<{ driver: StorageDriver; target: StorageTarget | null }>>();
    const sourceOf = (storageId: string | null) => {
      let found = sources.get(storageId);
      if (!found) {
        found = (async () => ({
          driver: await storageOf({ storageId }),
          target: storageId ? ((await loadTargets(eq(workspaceStorage.id, storageId)))[0] ?? null) : null,
        }))();
        sources.set(storageId, found);
      }
      return found;
    };
    let cursor = "";
    let moved = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (;;) {
      const batch = await db
        .select()
        .from(file)
        .where(and(where, gt(file.id, cursor)))
        .orderBy(asc(file.id))
        .limit(BATCH);
      if (!batch.length) break;
      for (const row of batch) {
        try {
          if (await moveFile(move.id, row, await sourceOf(row.storageId), destination)) moved++;
        } catch (error) {
          failed++;
          lastError = `${row.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`;
          console.warn(`[storage] move ${move.id} couldn't copy file ${row.id}`, error instanceof Error ? error.message : error);
        }
      }
      cursor = batch[batch.length - 1].id;
      await db
        .update(storageMove)
        .set({ moved: sql`${storageMove.moved} + ${moved}`, failed, lastError, lockedUntil: new Date(Date.now() + LEASE_MS) })
        .where(eq(storageMove.id, move.id));
      move.moved += moved;
      moved = 0;
    }
    const [{ left }] = await db.select({ left: sql<number>`count(*)::int` }).from(file).where(where);
    if (Number(left) > 0) {
      await db
        .update(storageMove)
        .set({ status: "failed", failed: Number(left), lastError: lastError ?? "Some files changed while they were moved; try again", lockedUntil: null, finishedAt: new Date() })
        .where(eq(storageMove.id, move.id));
      return false;
    }
    // Every file is across: the old copies may go now.
    await db.transaction(async (tx) => {
      await tx.update(storageDeletion).set({ moveId: null }).where(eq(storageDeletion.moveId, move.id));
      await tx
        .update(storageMove)
        .set({ status: "done", failed: 0, lastError: null, lockedUntil: null, finishedAt: new Date() })
        .where(eq(storageMove.id, move.id));
    });
    // Before the next move, so a move waited for (settleMoves) has also deleted the old copies.
    await cleanUpAfter();
    return true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    console.warn(`[storage] move ${move.id} of workspace ${move.workspaceId} stopped`, message);
    await db
      .update(storageMove)
      .set({ status: "failed", lastError: message, lockedUntil: null, finishedAt: new Date() })
      .where(eq(storageMove.id, move.id))
      .catch(() => undefined);
    return false;
  }
}

/**
 * Copies one file to the destination and points its row there, unless the file changed meanwhile
 * (deleted, or moved by someone else): then the copy is deleted again. The old copy is queued for
 * deletion, held by the move. Files already at the same place (two accounts for the same bucket)
 * are only pointed there. Returns whether the file moved.
 */
async function moveFile(
  moveId: string,
  row: typeof file.$inferSelect,
  source: { driver: StorageDriver; target: StorageTarget | null },
  destination: Destination,
): Promise<boolean> {
  const unchanged = and(
    eq(file.id, row.id),
    row.storageId ? eq(file.storageId, row.storageId) : isNull(file.storageId),
    eq(file.storageKey, row.storageKey),
  );
  const same = source.target && destination.target && sameLocation(targetLocation(source.target), targetLocation(destination.target));
  if (same) {
    const [pointed] = await db.update(file).set({ storageId: destination.storageId }).where(unchanged).returning({ id: file.id });
    return Boolean(pointed);
  }
  const body = await source.driver.get(refOf(row));
  if (!body) throw new StorageError("The file isn't in its storage any more");
  const objectId =
    (await destination.driver.put(row.storageKey, Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>), {
      size: row.size,
      contentType: row.contentType,
    })) || null;
  const pointed = await db.transaction(async (tx) => {
    const [updated] = await tx.update(file).set({ storageId: destination.storageId, storageObjectId: objectId }).where(unchanged).returning({ id: file.id });
    if (updated) {
      await tx
        .insert(storageDeletion)
        .values({ storageId: row.storageId, storageKey: row.storageKey, storageObjectId: row.storageObjectId, moveId })
        .onConflictDoNothing();
    }
    return Boolean(updated);
  });
  if (!pointed) await removeStored([{ storageId: destination.storageId, key: row.storageKey, objectId }]);
  return pointed;
}

async function cleanUpAfter() {
  try {
    await drainStorageDeletions();
    await removeRetiredStorage();
  } catch (error) {
    console.warn("[storage] cleanup after a move failed", error);
  }
}

let running: Promise<number> | null = null;

/** Runs the moves that are due now, unless this server is at it already. */
export function kickMoves(): void {
  if (running) return;
  running = runDueMoves()
    .catch((error) => {
      console.error("[storage] moving files failed", error);
      return 0;
    })
    .finally(() => {
      running = null;
    });
}

/** Waits for the moves this server is running (tests, and deleting an account). */
export async function settleMoves(): Promise<void> {
  while (running) await running;
}

let stop: (() => void) | null = null;

/** Every 30 seconds: moves queued, and those a stopped server left running. */
export function startStorageMoves() {
  stop ??= startSweep(30_000, async () => {
    kickMoves();
    await settleMoves();
  }, "[storage] move sweep failed");
  return stop;
}

/** Workspaces whose files are still in someone's storage, for the startup line while own storage is off. */
export async function countOwnStorageWorkspaces(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${workspaceStorage.workspaceId})::int` })
    .from(workspaceStorage)
    .where(and(sql`${workspaceStorage.workspaceId} is not null`, or(ne(workspaceStorage.status, "disconnected"), sql`exists (select 1 from ${file} f where f.storage_id = ${workspaceStorage.id})`)));
  return Number(row?.n ?? 0);
}

/** For an account being deleted: the moves of its storage under way. */
export async function openMovesAway(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(storageMove)
    .where(and(eq(storageMove.leaverId, userId), inArray(storageMove.status, OPEN)));
  return Number(row?.n ?? 0);
}
