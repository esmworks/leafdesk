import { Readable } from "node:stream";
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { file, storageAccount, storageDeletion, storageMove, workspace, workspaceStorage } from "@/db/schema";
import { env } from "@/lib/env";
import { sameLocation, type MoveDestinationView, type MoveReason, type StorageMoveView } from "@/lib/workspace-storage";
import { ownersInOrder, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { drainStorageDeletions, removeStored, workspaceUsage } from "@/server/files";
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
 * copy right away, one at a time, so every file stays readable throughout; the old copies are
 * queued for deletion held by the move, and deleted only once every file is across. A move picks up
 * where it was after a restart, and one with files it couldn't copy can be tried again.
 */

/** Files read from the database at a time. */
const BATCH = 20;
/** How long a worker holds a move before another server may take it over: renewed with every file. */
const LEASE_MS = 5 * 60_000;

/** The worker's lease on a move ran out and another worker took the move over: this one stops. */
class LeaseLost extends Error {}

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

/**
 * Whether files may still go to the storage account: it isn't disconnected, and the person it
 * belongs to is still an owner of the workspace (files never go to storage of someone who left).
 */
async function mayTakeFiles(reader: Reader, accountId: string, workspaceId: string) {
  const [account] = await reader.select({ userId: storageAccount.userId, status: storageAccount.status }).from(storageAccount).where(eq(storageAccount.id, accountId));
  if (!account?.userId || account.status === "disconnected") return false;
  return (await ownersInOrder(reader, workspaceId)).includes(account.userId);
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
  let destination: MoveDestination | null = move.toServer
    ? { toServer: true }
    : move.toAccountId && (await mayTakeFiles(db, move.toAccountId, workspaceId))
      ? { toAccountId: move.toAccountId }
      : null;
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
  const sameAccount = "toAccountId" in destination && destination.toAccountId === move.toAccountId;
  await db
    .update(storageMove)
    .set({
      status: "queued",
      // Somewhere else now: its place is made anew, connected by the owner trying again.
      ...(sameAccount ? {} : { toStorageId: null, startedBy: userId }),
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

type Claimed = { move: typeof storageMove.$inferSelect; lease: string };

/** Takes the next move that is due (queued, or running on a server whose lease ran out), under a new lease. */
async function claim(): Promise<Claimed | null> {
  const lease = crypto.randomUUID();
  const rows = await db.execute<{ id: string }>(sql`
    update ${storageMove} set status = 'running', locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval, lease_id = ${lease}, updated_at = now()
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
  return move ? { move, lease } : null;
}

/** The move while `lease` still holds it: every write a worker makes to its move is limited to this. */
const held = ({ move, lease }: Claimed) => and(eq(storageMove.id, move.id), eq(storageMove.leaseId, lease));

/**
 * Renews the worker's lease on its move, counting `moved` more files moved; throws LeaseLost when
 * another worker took the move over. Inside a transaction, it holds the move until that commits.
 */
async function renew(writer: Tx | typeof db, claimed: Claimed, moved = 0) {
  const [row] = await writer
    .update(storageMove)
    .set({ lockedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval`, moved: sql`${storageMove.moved} + ${moved}` })
    .where(held(claimed))
    .returning({ id: storageMove.id });
  if (!row) throw new LeaseLost();
}

/** Moves every move that is due, one after the other. Returns how many finished. */
export async function runDueMoves(): Promise<number> {
  let finished = 0;
  for (;;) {
    const claimed = await claim();
    if (!claimed) return finished;
    if (await runMove(claimed)) finished++;
  }
}

type Destination = { storageId: string | null; driver: StorageDriver; target: StorageTarget | null };

/**
 * The move's destination, made ready: its place in the storage account made (a Drive folder) and
 * tried, and made where the workspace's new uploads go; or, for the server's storage, the
 * workspace's own storage disconnected so new uploads go to the server's.
 */
async function prepare(claimed: Claimed): Promise<Destination> {
  const { move } = claimed;
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
  if (!move.toAccountId) throw new StorageError("The storage the files were to go to was disconnected");
  if (!(await mayTakeFiles(db, move.toAccountId, move.workspaceId))) {
    throw new StorageError("The storage the files were to go to was disconnected, or its owner isn't an owner of the workspace any more");
  }
  if (move.toStorageId) {
    const [target] = await loadTargets(eq(workspaceStorage.id, move.toStorageId));
    if (target) return { storageId: target.id, driver: await storageOf({ storageId: target.id }), target };
  }
  const [account] = await db.select().from(storageAccount).where(eq(storageAccount.id, move.toAccountId));
  if (!account || account.status === "disconnected" || !account.userId) throw new StorageError("The storage the files were to go to was disconnected");
  const made = await placeFor(account, move.workspaceId);
  const { id } = await db.transaction(async (tx) => {
    await lockWorkspaceStorage(tx, move.workspaceId);
    const result = await makeCurrent(tx, { workspaceId: move.workspaceId, account: made.account, place: made.place, userId: move.startedBy });
    const [mine] = await tx.update(storageMove).set({ toStorageId: result.id }).where(held(claimed)).returning({ id: storageMove.id });
    if (!mine) throw new LeaseLost();
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
async function runMove(claimed: Claimed): Promise<boolean> {
  const { move } = claimed;
  try {
    const destination = await prepare(claimed);
    const where = movable(move, destination.storageId);
    const [{ remaining }] = await db.select({ remaining: sql<number>`count(*)::int` }).from(file).where(where);
    const [counted] = await db
      .update(storageMove)
      .set({ files: sql`${storageMove.moved} + ${Number(remaining)}`, failed: 0, lastError: null })
      .where(held(claimed))
      .returning({ id: storageMove.id });
    if (!counted) throw new LeaseLost();
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
        // Before copying anything: a worker whose move was taken over stops here.
        await renew(db, claimed);
        try {
          await moveFile(claimed, row, await sourceOf(row.storageId), destination);
        } catch (error) {
          if (error instanceof LeaseLost) throw error;
          failed++;
          lastError = `${row.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`;
          console.warn(`[storage] move ${move.id} couldn't copy file ${row.id}`, error instanceof Error ? error.message : error);
        }
      }
      cursor = batch[batch.length - 1].id;
      await db.update(storageMove).set({ failed, lastError }).where(held(claimed));
    }
    const [{ left }] = await db.select({ left: sql<number>`count(*)::int` }).from(file).where(where);
    if (Number(left) > 0) {
      await db
        .update(storageMove)
        .set({ status: "failed", failed: Number(left), lastError: lastError ?? "Some files changed while they were moved; try again", lockedUntil: null, finishedAt: new Date() })
        .where(held(claimed));
      return false;
    }
    // Every file is across: the old copies may go now.
    await db.transaction(async (tx) => {
      const [done] = await tx
        .update(storageMove)
        .set({ status: "done", failed: 0, lastError: null, lockedUntil: null, finishedAt: new Date() })
        .where(held(claimed))
        .returning({ id: storageMove.id });
      if (!done) throw new LeaseLost();
      await tx.update(storageDeletion).set({ moveId: null }).where(eq(storageDeletion.moveId, move.id));
    });
    // Before the next move, so a move waited for (settleMoves) has also deleted the old copies.
    await cleanUpAfter();
    return true;
  } catch (error) {
    if (error instanceof LeaseLost) {
      // Another worker has the move now and carries on with it.
      console.warn(`[storage] move ${move.id} of workspace ${move.workspaceId} was taken over by another worker`);
      return false;
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    console.warn(`[storage] move ${move.id} of workspace ${move.workspaceId} stopped`, message);
    await db
      .update(storageMove)
      .set({ status: "failed", lastError: message, lockedUntil: null, finishedAt: new Date() })
      .where(held(claimed))
      .catch(() => undefined);
    return false;
  }
}

/**
 * Copies one file to the destination and points its row there, unless the file changed meanwhile
 * (deleted, or moved by someone else): then the copy is deleted again, as it is when pointing the
 * row fails. The old copy is queued for deletion, held by the move. Files already at the same place
 * (two accounts for the same bucket) are only pointed there. The row is pointed only while the
 * worker still holds the move (counting the file), and onto the server's storage only while the
 * workspace's files fit its quota there. Throws LeaseLost when the move was taken over: the copy
 * stays then, as the worker that has the move now writes the same object.
 */
async function moveFile(
  claimed: Claimed,
  row: typeof file.$inferSelect,
  source: { driver: StorageDriver; target: StorageTarget | null },
  destination: Destination,
): Promise<void> {
  const unchanged = and(
    eq(file.id, row.id),
    row.storageId ? eq(file.storageId, row.storageId) : isNull(file.storageId),
    eq(file.storageKey, row.storageKey),
  );
  const same = source.target && destination.target && sameLocation(targetLocation(source.target), targetLocation(destination.target));
  if (same) {
    await db.transaction(async (tx) => {
      const [pointed] = await tx.update(file).set({ storageId: destination.storageId }).where(unchanged).returning({ id: file.id });
      await renew(tx, claimed, pointed ? 1 : 0);
    });
    return;
  }
  const workspaceId = claimed.move.workspaceId;
  const quota = destination.storageId === null ? uploadLimits().workspaceQuotaBytes : Infinity;
  const overQuota = () => new StorageError("The workspace's files would pass its quota on the server's storage");
  if (quota !== Infinity && (await workspaceUsage(workspaceId)) + row.size > quota) throw overQuota();
  const body = await source.driver.get(refOf(row));
  if (!body) throw new StorageError("The file isn't in its storage any more");
  const objectId =
    (await destination.driver.put(row.storageKey, Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>), {
      size: row.size,
      contentType: row.contentType,
    })) || null;
  const copy = { storageId: destination.storageId, key: row.storageKey, objectId };
  let pointed: boolean;
  try {
    pointed = await db.transaction(async (tx) => {
      if (quota !== Infinity) {
        // As uploads do (files.storeFile): one at a time per workspace past this point, so the sum is current.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:file-quota:${workspaceId}`}))`);
        if ((await workspaceUsage(workspaceId, tx)) + row.size > quota) throw overQuota();
      }
      const [updated] = await tx.update(file).set({ storageId: destination.storageId, storageObjectId: objectId }).where(unchanged).returning({ id: file.id });
      if (updated) {
        await tx
          .insert(storageDeletion)
          .values({ storageId: row.storageId, storageKey: row.storageKey, storageObjectId: row.storageObjectId, moveId: claimed.move.id })
          .onConflictDoNothing();
      }
      await renew(tx, claimed, updated ? 1 : 0);
      return Boolean(updated);
    });
  } catch (error) {
    if (!(error instanceof LeaseLost)) await removeStored([copy]);
    throw error;
  }
  if (!pointed) await removeStored([copy]);
}

async function cleanUpAfter() {
  try {
    await drainStorageDeletions();
    await removeRetiredStorage();
  } catch (error) {
    console.warn("[storage] cleanup after a move failed", error);
  }
}

/** The moves this server is running: one per process, however many copies of this module it loaded. */
const RUNNING_KEY = "__leafdeskStorageMoves";
const runs = ((globalThis as Record<string, unknown>)[RUNNING_KEY] ??= { running: null }) as { running: Promise<number> | null };

/** Runs the moves that are due now, unless this server is at it already. */
export function kickMoves(): void {
  if (runs.running) return;
  runs.running = runDueMoves()
    .catch((error) => {
      console.error("[storage] moving files failed", error);
      return 0;
    })
    .finally(() => {
      runs.running = null;
    });
}

/** Waits for the moves this server is running (tests, and deleting an account). */
export async function settleMoves(): Promise<void> {
  while (runs.running) await runs.running;
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
