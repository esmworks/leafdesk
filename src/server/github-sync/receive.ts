import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { githubDelivery, githubSync, page } from "@/db/schema";
import {
  GITHUB_ACTIONS,
  GITHUB_DELIVERIES_MAX,
  GITHUB_PER_MINUTE,
  MAX_GITHUB_BODY_BYTES,
  deliveriesForgottenBefore,
  nextStatus,
  pullRequestIds,
  pullRequestOf,
  statusMove,
  withLink,
  type GithubDeliveryError,
  type GithubDeliveryRow,
  type PullRequest,
} from "@/lib/github-sync";
import { PropertyValueError } from "@/lib/properties";
import { SlidingWindowLimiter } from "@/lib/rate-limit";
import { redactError } from "@/lib/redact";
import { uniqueIdPrefix } from "@/lib/unique-id";
import { AccessError } from "@/server/access";
import { verifyEvent } from "@/server/connections/verify";
import { getProperties, requireDatabase, updateRowProperties } from "@/server/databases";
import { BodyTooLargeError, readBodyLimited } from "@/server/request-body";
import { open } from "@/server/secret-box";

/**
 * Deliveries GitHub sends a database's setup (./manage) at `/api/github/<id>`: checked against its
 * secret (`X-Hub-Signature-256`, as connections check GitHub's events), taken once (by
 * `X-GitHub-Delivery`; a delivery GitHub sends again after the server failed on it is handled
 * then), and handled in the request, which stays short: a pull request names at most
 * MAX_GITHUB_ROWS rows. Each row it names gets the pull request's link and the status the setup
 * gives what happened (lib/github-sync nextStatus), written as the person who saved the setup, with
 * their access now: a row they can't edit is skipped. These are their own writes, so automations
 * of the database run on them ("Status becomes Done" after a merge). Deliveries of one setup are
 * handled one after another, so two pull requests naming a row both add their link.
 */

export type GithubResponse = { status: number; body: Record<string, unknown> };

const g = globalThis as typeof globalThis & { __leafdeskGithubRate?: SlidingWindowLimiter; __leafdeskGithubQueue?: Map<string, Promise<unknown>> };
const limiter = (g.__leafdeskGithubRate ??= new SlidingWindowLimiter(GITHUB_PER_MINUTE, 60_000));
const queues = (g.__leafdeskGithubQueue ??= new Map());

/** Runs `work` after the setup's earlier deliveries are done. */
function inTurn<T>(syncId: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(syncId) ?? Promise.resolve();
  const next = before.then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(syncId, settled);
  void settled.then(() => {
    if (queues.get(syncId) === settled) queues.delete(syncId);
  });
  return next;
}

type Sync = typeof githubSync.$inferSelect;

/** Takes a delivery for a setup: checks it, keeps it, and handles a pull request's. */
export async function receiveGithub(syncId: string, request: Request): Promise<GithubResponse> {
  const [sync] = await db.select().from(githubSync).where(eq(githubSync.id, syncId)).limit(1);
  if (!sync) return { status: 404, body: { error: "Unknown address" } };
  let text: string;
  try {
    text = new TextDecoder().decode(await readBodyLimited(request, MAX_GITHUB_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return { status: 413, body: { error: "The delivery is too large" } };
    throw error;
  }
  let secret: string;
  try {
    secret = open(sync.secret);
  } catch {
    return { status: 500, body: { error: "The secret can't be read: make a new one" } };
  }
  const verified = verifyEvent("github", secret, request.headers, text);
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } };
  const wait = limiter.retryAfter(sync.id);
  if (wait > 0) return { status: 429, body: { error: "Too many deliveries; slow down" } };
  limiter.hit(sync.id);

  const event = (request.headers.get("x-github-event") ?? "").trim().slice(0, 100) || "event";
  const pr = event === "pull_request" ? pullRequestOf(verified.payload) : null;
  const handled = pr !== null && (GITHUB_ACTIONS as readonly string[]).includes(pr.action);
  const action = (verified.payload as { action?: unknown } | null)?.action;
  const deliveryId = verified.deliveryId.slice(0, 200);
  let [delivery] = await db
    .insert(githubDelivery)
    .values({
      syncId: sync.id,
      deliveryId,
      signature: verified.signature.slice(0, 300),
      event,
      action: typeof action === "string" ? action.slice(0, 100) : null,
      status: handled ? "received" : "ignored",
      pullRequest: pr ? { repo: pr.repo.slice(0, 200), number: pr.number, title: pr.title.slice(0, 300), url: pr.url.slice(0, 500) } : null,
    })
    // Either key taken (the delivery id, or the signature under another id) means seen before.
    .onConflictDoNothing()
    .returning({ id: githubDelivery.id });
  if (!delivery) {
    const [seen] = await db
      .select({ id: githubDelivery.id, status: githubDelivery.status })
      .from(githubDelivery)
      .where(and(eq(githubDelivery.syncId, sync.id), eq(githubDelivery.deliveryId, deliveryId)));
    // Sent again after the server failed on it: handled now. Anything else was handled.
    if (seen?.status !== "received") return { status: 200, body: { ok: true, duplicate: true } };
    delivery = seen;
  }
  await prune(sync.id);
  if (!handled) return { status: 200, body: { ok: true, ignored: true } };

  const outcome = await inTurn(sync.id, () => handlePullRequest(sync, pr)).catch((error: unknown) => {
    console.error("[github] could not handle a delivery", redactError(error));
    return { rows: [] as GithubDeliveryRow[], error: "failed" as const };
  });
  await db
    .update(githubDelivery)
    .set({ status: outcome.error ? "failed" : "done", rows: outcome.rows, error: outcome.error })
    .where(eq(githubDelivery.id, delivery.id));
  return { status: 200, body: { ok: !outcome.error, rows: outcome.rows.filter((r) => r.outcome === "updated").length } };
}

/**
 * Forgets a setup's deliveries older than GITHUB_DELIVERY_DAYS (and past the newest
 * GITHUB_DELIVERIES_MAX): a delivery is known again, and refused, as long as one sent again could be.
 */
async function prune(syncId: string, now = new Date()) {
  const [oldestKept] = await db
    .select({ at: githubDelivery.receivedAt })
    .from(githubDelivery)
    .where(eq(githubDelivery.syncId, syncId))
    .orderBy(desc(githubDelivery.receivedAt))
    .offset(GITHUB_DELIVERIES_MAX - 1)
    .limit(1);
  const before = deliveriesForgottenBefore(now, oldestKept?.at ?? null);
  await db.delete(githubDelivery).where(and(eq(githubDelivery.syncId, syncId), lt(githubDelivery.receivedAt, before)));
}

/** Writes a pull request to the rows it names, as the setup's person. */
export async function handlePullRequest(sync: Sync, pr: PullRequest): Promise<{ rows: GithubDeliveryRow[]; error: GithubDeliveryError | null }> {
  const failed = (error: GithubDeliveryError) => ({ rows: [], error });
  if (!sync.runAs) return failed("runAsGone");
  try {
    const database = await requireDatabase(sync.runAs, sync.databaseId, "edit");
    if (database.archivedAt) return failed("inTrash");
  } catch (error) {
    if (error instanceof AccessError) return failed("accessLost");
    throw error;
  }
  const props = await getProperties(sync.databaseId);
  const uid = props.find((p) => p.type === "unique_id");
  const prefix = uid ? uniqueIdPrefix(uid) : null;
  if (!uid || !prefix) return failed("noUniqueId");
  const numbers = pullRequestIds(pr, prefix);
  if (!numbers.length) return { rows: [], error: null };

  const found = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(
      and(
        eq(page.parentId, sync.databaseId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        inArray(sql`${page.properties} -> ${uid.id}`, numbers.map((n) => sql`${String(n)}::jsonb`)),
      ),
    );
  const byNumber = new Map(found.map((row) => [Number(row.properties[uid.id]), row]));
  const { mapping } = sync;
  const link = props.find((p) => p.id === mapping.linkPropertyId && (p.type === "text" || p.type === "url"));
  const status = props.find((p) => p.id === mapping.statusPropertyId && p.type === "status");
  const move = statusMove(pr);

  const rows: GithubDeliveryRow[] = [];
  for (const n of numbers) {
    const id = `${prefix}-${n}`;
    const row = byNumber.get(n);
    if (!row) {
      rows.push({ id, outcome: "notFound" });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (link) {
      const next = withLink(row.properties[link.id], pr.url, link.type as "text" | "url");
      if (next !== null) patch[link.id] = next;
    }
    if (status) {
      const next = nextStatus(row.properties[status.id], move, mapping, status.options.options ?? []);
      if (next !== null) patch[status.id] = next;
    }
    if (!Object.keys(patch).length) {
      rows.push({ id, outcome: "unchanged" });
      continue;
    }
    try {
      await updateRowProperties(sync.runAs, row.id, patch);
      rows.push({ id, outcome: "updated" });
    } catch (error) {
      if (error instanceof AccessError) rows.push({ id, outcome: "noAccess" });
      else if (error instanceof PropertyValueError) rows.push({ id, outcome: "failed", error: error.message.slice(0, 300) });
      else {
        console.error("[github] could not write a row", redactError(error));
        rows.push({ id, outcome: "failed" });
      }
    }
  }
  return { rows, error: null };
}
