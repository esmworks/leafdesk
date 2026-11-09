import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMessage } from "@/db/schema";
import { env } from "@/lib/env";
import { messageLinks, previewWorthShowing } from "@/lib/message-links";
import type { MessagePreview } from "@/lib/messages";
import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import { fetchLinkPreview, type LinkPreview } from "@/server/link-preview";
import { MessageError, requireChannel, write } from "./core";

/**
 * The cards under a message for the web links it holds: fetched once by the server after the
 * message is stored or its words change, with the bookmark's checks (server/link-preview.ts: public
 * addresses only, five seconds, the page's head), and kept in the message's `data.previews`, so
 * everyone reading it sees the same cards and nobody's browser asks the site anything but its
 * images. A card arrives as a change of the message, through `write`, like an edit.
 *
 * Links to this app are left out (they show as mentions), and so are links in code and those written
 * `<https://…>`. A link fetched lately is not fetched again: answers are kept a day for everyone,
 * and failures an hour. Only fetches count towards the author's budget.
 */

const KEPT_MS = 24 * 60 * 60_000;
const FAILED_KEPT_MS = 60 * 60_000;
const MAX_KEPT = 2_000;

type Kept = { until: number; preview: Promise<MessagePreview | null> };
const KEY = "__leafdeskMessagePreviews";
const kept = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Kept>()) as Map<string, Kept>;

// As many as a person pasting links all day sends, not a crawler's worth.
const perMinute = new SlidingWindowLimiter(20, 60_000);
const perHour = new SlidingWindowLimiter(200, 60 * 60_000);

type Fetch = (url: string) => Promise<LinkPreview>;

/** Whether `url` is one of this app's own pages. */
function ours(url: URL): boolean {
  try {
    return url.host === new URL(env.appUrl).host;
  } catch {
    return false;
  }
}

function cardOf(found: LinkPreview, url: string): MessagePreview | null {
  const card = { url, title: found.title, description: found.description, image: found.image, favicon: found.favicon, siteName: found.siteName };
  return previewWorthShowing(card) ? card : null;
}

async function previewOf(authorId: string, url: string, fetch: Fetch, now: number): Promise<MessagePreview | null> {
  const known = kept.get(url);
  if (known && known.until > now) return known.preview;
  if (takeAll([[perMinute, authorId], [perHour, authorId]], now) > 0) return null;
  const preview = fetch(url).then(
    (found) => cardOf(found, url),
    () => null,
  );
  keep(url, { until: now + KEPT_MS, preview });
  void preview.then((found) => {
    if (!found && kept.get(url)?.preview === preview) keep(url, { until: now + FAILED_KEPT_MS, preview });
  });
  return preview;
}

function keep(url: string, entry: Kept) {
  kept.delete(url);
  kept.set(url, entry);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}

const sameCards = (a: MessagePreview[] | undefined, b: MessagePreview[]) =>
  (a ?? []).length === b.length && (a ?? []).every((p, i) => p.url === b[i].url && p.title === b[i].title && p.image === b[i].image);

/**
 * Fetches the cards for message `messageId`'s links and stores them on it, unless its words changed
 * meanwhile (that change brings its own run) or its author took the previews away. Never throws:
 * a message without its cards is still a message.
 */
export async function previewMessageLinks(messageId: string, fetch: Fetch = fetchLinkPreview, now = Date.now()): Promise<void> {
  try {
    const [row] = await db
      .select({ body: channelMessage.body, data: channelMessage.data, authorId: channelMessage.authorId, kind: channelMessage.kind, deletedAt: channelMessage.deletedAt, workspaceId: channel.workspaceId })
      .from(channelMessage)
      .innerJoin(channel, eq(channel.id, channelMessage.channelId))
      .where(eq(channelMessage.id, messageId))
      .limit(1);
    if (!row || !row.authorId || row.kind !== "message" || row.deletedAt || row.data?.previewsHidden) return;
    const links = messageLinks(row.body, ours);
    const found = await Promise.all(links.map((url) => previewOf(row.authorId!, url, fetch, now)));
    const cards = found.filter((p): p is MessagePreview => p !== null);
    if (sameCards(row.data?.previews, cards)) return;
    await write(row.workspaceId, async (tx, changed) => {
      const [current] = await tx
        .select({ body: channelMessage.body, data: channelMessage.data, deletedAt: channelMessage.deletedAt })
        .from(channelMessage)
        .where(eq(channelMessage.id, messageId))
        .for("update");
      if (!current || current.body !== row.body || current.deletedAt || current.data?.previewsHidden) return;
      const { previews: _, ...rest } = current.data ?? {};
      await tx
        .update(channelMessage)
        .set({ data: cards.length ? { ...rest, previews: cards } : Object.keys(rest).length ? rest : null, rev: changed.rev })
        .where(eq(channelMessage.id, messageId));
      changed.message(messageId);
    });
  } catch (error) {
    console.error("[messages] could not preview a message's links", error);
  }
}

/** Starts `previewMessageLinks` without waiting, when the words hold a link worth looking at. */
export function previewSoon(messageId: string, body: string) {
  if (messageLinks(body, ours, 1).length) void previewMessageLinks(messageId);
}

/** The author takes the cards away from their message; none come back for it, even after an edit. */
export async function hidePreviews(userId: string, workspaceId: string, messageId: unknown): Promise<void> {
  if (typeof messageId !== "string") throw new MessageError("invalid");
  const [row] = await db
    .select({ channelId: channelMessage.channelId, authorId: channelMessage.authorId, data: channelMessage.data, workspaceId: channel.workspaceId })
    .from(channelMessage)
    .innerJoin(channel, eq(channel.id, channelMessage.channelId))
    .where(eq(channelMessage.id, messageId))
    .limit(1);
  if (!row || row.workspaceId !== workspaceId) throw new MessageError("notFound");
  await requireChannel(userId, row.channelId);
  if (row.authorId !== userId) throw new MessageError("notAllowed");
  if (row.data?.previewsHidden) return;
  await write(workspaceId, async (tx, changed) => {
    const [current] = await tx.select({ data: channelMessage.data }).from(channelMessage).where(eq(channelMessage.id, messageId)).for("update");
    const { previews: _, ...rest } = current?.data ?? {};
    await tx
      .update(channelMessage)
      .set({ data: { ...rest, previewsHidden: true }, rev: changed.rev })
      .where(eq(channelMessage.id, messageId));
    changed.message(messageId);
  });
}

/** Tests only: forgets every kept card. */
export function forgetMessagePreviews() {
  kept.clear();
}
