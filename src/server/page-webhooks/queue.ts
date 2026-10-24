import { and, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, pageWebhook, pageWebhookDelivery, pageWebhookPending } from "@/db/schema";
import { PAGE_UPDATE_IDLE_MS, PAGE_UPDATE_MAX_WAIT_MS } from "@/lib/page-watch";
import { CREATED_DELAY_MS, type DeliveryDetails, type PageWebhookEvent } from "@/lib/page-webhooks";
import { redactError } from "@/lib/redact";
import { accessRank } from "@/server/access";

/**
 * What happens to pages, turned into page webhook deliveries (sent by ./deliver.ts). Each call
 * queues one delivery for every subscription of the page's workspace that is on, lists the event
 * and holds the page in its scope right now: the whole workspace, its teamspace, or a page it is
 * that page or under. Database rows and templates are left out (automations' webhooks are for
 * rows). Whether the subscription's person may open the page is checked when it is sent. Nothing
 * here throws into the change it is about.
 */

const parent = alias(page, "parent");

/** The page as scopes see it; null for rows, templates and pages that are gone. */
async function loadEventPage(pageId: string) {
  const [found] = await db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      teamspaceId: page.teamspaceId,
      parentId: page.parentId,
      isTemplate: page.isTemplate,
      inTemplate: page.inTemplate,
      parentKind: parent.kind,
    })
    .from(page)
    .leftJoin(parent, eq(parent.id, page.parentId))
    .where(eq(page.id, pageId))
    .limit(1);
  if (!found || found.parentKind === "database" || found.isTemplate || found.inTemplate) return null;
  return found;
}

/** SQL: the ids of `pageId` and the pages above it (a page scope holds the page when it is one of them). */
const selfAndAbove = (pageId: string | null) =>
  sql`(with recursive up as (
    select id, parent_id from ${page} where id = ${pageId}
    union all
    select p.id, p.parent_id from ${page} p join up on p.id = up.parent_id
  ) select id from up)`;

/** One place a page is (or was, before a move): its teamspace and the page it is under (or itself). */
type Place = { teamspaceId: string | null; at: string | null };

/** SQL: the subscription holds a page in one of `places`. */
function inScope(places: Place[]): SQL {
  const teamspaces = [...new Set(places.flatMap((p) => (p.teamspaceId ? [p.teamspaceId] : [])))];
  return sql`(${pageWebhook.scope} = 'workspace'
    ${teamspaces.length ? sql`or (${pageWebhook.scope} = 'teamspace' and ${inArray(pageWebhook.teamspaceId, teamspaces)})` : sql``}
    ${sql.join(
      places.filter((p) => p.at).map((p) => sql`or (${pageWebhook.scope} = 'page' and ${pageWebhook.pageId} in ${selfAndAbove(p.at)})`),
      sql` `,
    )})`;
}

/** The subscriptions of the workspace that are on and listen for `event`. */
const listening = (workspaceId: string, event: PageWebhookEvent) =>
  and(
    eq(pageWebhook.workspaceId, workspaceId),
    eq(pageWebhook.enabled, true),
    isNull(pageWebhook.paused),
    sql`${pageWebhook.events} @> ${JSON.stringify([event])}::jsonb`,
  );

async function enqueue(
  event: PageWebhookEvent,
  target: { id: string; workspaceId: string },
  places: Place[],
  details: DeliveryDetails,
  { delayMs = 0, unless }: { delayMs?: number; unless?: SQL } = {},
) {
  const hooks = await db
    .select({ id: pageWebhook.id })
    .from(pageWebhook)
    .where(and(listening(target.workspaceId, event), inScope(places), unless));
  if (!hooks.length) return 0;
  const due = new Date(Date.now() + delayMs);
  await db.insert(pageWebhookDelivery).values(
    hooks.map((h) => ({ webhookId: h.id, workspaceId: target.workspaceId, event, pageId: target.id, details, nextAttemptAt: due })),
  );
  return hooks.length;
}

/** Runs `work`, logging instead of throwing. */
async function quietly(what: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    console.error(`[page-webhooks] could not queue ${what}`, redactError(error));
  }
}

/**
 * A page was made. Its delivery waits CREATED_DELAY_MS, so a body written right after it (the
 * API and MCP write it in a second step) goes with it.
 */
export function queuePageCreated(pageId: string, actorId: string | null) {
  return quietly("page.created", async () => {
    const target = await loadEventPage(pageId);
    if (target) await enqueue("page.created", target, [{ teamspaceId: target.teamspaceId, at: target.id }], { actorId }, { delayMs: CREATED_DELAY_MS });
  });
}

/**
 * A save of the page changed its title or body. Saves wait in `page_webhook_pending` until the
 * page is left alone for a while, like page watching's (lib/page-watch), so a session of writing
 * is one `page.updated`; ./deliver.ts turns those that are due into deliveries.
 */
export function queuePageUpdated(pageId: string, actorId: string | null, changed: { title: boolean; body: boolean }) {
  return quietly("page.updated", async () => {
    const target = await loadEventPage(pageId);
    if (!target) return;
    // Most workspaces have no webhook: nothing waits for them.
    const [any] = await db.select({ id: pageWebhook.id }).from(pageWebhook).where(listening(target.workspaceId, "page.updated")).limit(1);
    if (!any) return;
    const now = new Date();
    await db
      .insert(pageWebhookPending)
      .values({ pageId, actorId, title: changed.title, body: changed.body, firstAt: now, dueAt: new Date(now.getTime() + PAGE_UPDATE_IDLE_MS) })
      .onConflictDoUpdate({
        target: pageWebhookPending.pageId,
        set: {
          actorId: sql`excluded.actor_id`,
          title: sql`${pageWebhookPending.title} or excluded.title`,
          body: sql`${pageWebhookPending.body} or excluded.body`,
          dueAt: sql`least(excluded.due_at, ${pageWebhookPending.firstAt} + make_interval(secs => ${PAGE_UPDATE_MAX_WAIT_MS / 1000}))`,
        },
      });
  });
}

/**
 * Edits that waited long enough become `page.updated` deliveries, but for subscriptions whose
 * `page.created` for the page is still waiting to go: that one carries the page as it is by then.
 */
export async function releaseDueUpdates(now: Date) {
  const due = await db
    .delete(pageWebhookPending)
    .where(lte(pageWebhookPending.dueAt, now))
    .returning();
  for (const pending of due) {
    await quietly("page.updated", async () => {
      const target = await loadEventPage(pending.pageId);
      if (!target) return;
      const createdWaiting = sql`not exists (select 1 from ${pageWebhookDelivery} d where d.webhook_id = ${pageWebhook.id} and d.page_id = ${target.id} and d.event = 'page.created' and d.status = 'pending' and d.attempts = 0)`;
      await enqueue(
        "page.updated",
        target,
        [{ teamspaceId: target.teamspaceId, at: target.id }],
        { actorId: pending.actorId, title: pending.title, body: pending.body },
        { unless: createdWaiting },
      );
    });
  }
  return due.length;
}

/** A page moved; subscriptions that held it before or hold it now hear about it. */
export function queuePageMoved(pageId: string, actorId: string | null, from: { parentId: string | null; teamspaceId: string | null }) {
  return quietly("page.moved", async () => {
    const target = await loadEventPage(pageId);
    if (!target) return;
    await enqueue(
      "page.moved",
      target,
      [
        { teamspaceId: target.teamspaceId, at: target.id },
        { teamspaceId: from.teamspaceId, at: from.parentId },
      ],
      { actorId, from },
    );
  });
}

/** A page went to the trash with the pages under it (one event, for it), or came back from it. */
export function queuePageTrashed(pageId: string, actorId: string | null, restored = false) {
  const event = restored ? "page.restored" : "page.trashed";
  return quietly(event, async () => {
    const target = await loadEventPage(pageId);
    if (target) await enqueue(event, target, [{ teamspaceId: target.teamspaceId, at: target.id }], { actorId });
  });
}

/** A comment was written on the page: a new thread, or a reply in one. */
export function queueCommentCreated(pageId: string, actorId: string, comment: { threadId: string; commentId: string; reply: boolean; text: string }) {
  return quietly("comment.created", async () => {
    const target = await loadEventPage(pageId);
    if (!target) return;
    await enqueue("comment.created", target, [{ teamspaceId: target.teamspaceId, at: target.id }], {
      actorId,
      comment: { threadId: comment.threadId, commentId: comment.commentId, reply: comment.reply, text: comment.text.slice(0, 10_000) },
    });
  });
}

/**
 * Pages about to be deleted for good: what their `page.deleted` deliveries need, worked out while
 * the pages are still there (their place, title and kind, and whether each subscription's person
 * could open them). Pass the result to `queuePagesDeleted` once the delete is done. Only the pages
 * named, not those under them.
 */
export async function beforePagesDeleted(workspaceId: string, pageIds: string[]) {
  const out: { pageId: string; webhookId: string; title: string; kind: string; visible: boolean }[] = [];
  try {
    const hooks = await db
      .select({ id: pageWebhook.id, ownerId: pageWebhook.ownerId })
      .from(pageWebhook)
      .where(listening(workspaceId, "page.deleted"));
    if (!hooks.length || !pageIds.length) return out;
    const pages = await db
      .select({ id: page.id, title: page.title, kind: page.kind, teamspaceId: page.teamspaceId, isTemplate: page.isTemplate, inTemplate: page.inTemplate, parentKind: parent.kind })
      .from(page)
      .leftJoin(parent, eq(parent.id, page.parentId))
      .where(and(eq(page.workspaceId, workspaceId), inArray(page.id, pageIds)));
    for (const p of pages) {
      if (p.parentKind === "database" || p.isTemplate || p.inTemplate) continue;
      const held = await db
        .select({ id: pageWebhook.id, ownerId: pageWebhook.ownerId })
        .from(pageWebhook)
        .where(and(listening(workspaceId, "page.deleted"), inScope([{ teamspaceId: p.teamspaceId, at: p.id }])));
      for (const hook of held) {
        const visible = hook.ownerId
          ? Number((await db.select({ level: accessRank(hook.ownerId, sql`${page.id}`) }).from(page).where(eq(page.id, p.id)))[0]?.level ?? 0) > 0
          : false;
        out.push({ pageId: p.id, webhookId: hook.id, title: p.title, kind: p.kind, visible });
      }
    }
  } catch (error) {
    console.error("[page-webhooks] could not prepare page.deleted", redactError(error));
  }
  return out;
}

/** Queues the `page.deleted` deliveries `beforePagesDeleted` prepared, for the pages that were deleted. */
export function queuePagesDeleted(
  workspaceId: string,
  prepared: Awaited<ReturnType<typeof beforePagesDeleted>>,
  deletedIds: string[],
  actorId: string | null,
) {
  return quietly("page.deleted", async () => {
    const gone = new Set(deletedIds);
    const rows = prepared.filter((p) => gone.has(p.pageId));
    if (!rows.length) return;
    // A subscription scoped to a page deleted with it went with it (its row cascades).
    const alive = new Set(
      (await db.select({ id: pageWebhook.id }).from(pageWebhook).where(inArray(pageWebhook.id, [...new Set(rows.map((r) => r.webhookId))]))).map((h) => h.id),
    );
    const values = rows
      .filter((r) => alive.has(r.webhookId))
      .map((r) => ({
        webhookId: r.webhookId,
        workspaceId,
        event: "page.deleted",
        pageId: r.pageId,
        details: { actorId, deleted: { title: r.title, kind: r.kind, visible: r.visible } } satisfies DeliveryDetails,
        nextAttemptAt: new Date(),
      }));
    if (values.length) await db.insert(pageWebhookDelivery).values(values);
  });
}
