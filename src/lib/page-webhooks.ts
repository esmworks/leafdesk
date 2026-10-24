/**
 * Page webhooks (server/page-webhooks): a workspace's owners subscribe an https address to what
 * happens to its pages (the whole workspace, a teamspace, or a page and everything under it), and
 * each event goes there as a signed JSON POST, as automation webhooks are. Pure, for the server,
 * the settings tab and the REST API alike.
 */

/** What a subscription can hear about, in the order settings lists them. */
export const PAGE_WEBHOOK_EVENTS = [
  "page.created",
  "page.updated",
  "page.moved",
  "page.trashed",
  "page.restored",
  "page.deleted",
  "comment.created",
] as const;
export type PageWebhookEvent = (typeof PAGE_WEBHOOK_EVENTS)[number];

export const isPageWebhookEvent = (value: unknown): value is PageWebhookEvent =>
  typeof value === "string" && (PAGE_WEBHOOK_EVENTS as readonly string[]).includes(value);

/** The event of a test delivery (*Send test*). */
export const PING_EVENT = "ping";

/** Where the pages a subscription hears about are: the whole workspace, one teamspace, or a page and the pages under it. */
export const PAGE_WEBHOOK_SCOPES = ["workspace", "teamspace", "page"] as const;
export type PageWebhookScope = (typeof PAGE_WEBHOOK_SCOPES)[number];

export const isPageWebhookScope = (value: unknown): value is PageWebhookScope =>
  typeof value === "string" && (PAGE_WEBHOOK_SCOPES as readonly string[]).includes(value);

/**
 * Why a subscription stopped sending: whoever last saved it is no longer an owner of the
 * workspace (they left, were removed or became a member). An owner saving it again sends as them.
 */
export type PageWebhookPause = "notOwner";

/**
 * How a delivery went: waiting (to be sent, or to be tried again), sent (2xx), failed (it ran out
 * of tries, or the address refused it in a way trying again won't fix) or skipped (nothing was
 * sent: see DeliveryCode).
 */
export const DELIVERY_STATUSES = ["pending", "delivered", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Why a delivery failed or was skipped. Skipped: the subscription's person can't open the page now
 * (`noAccess`), isn't an owner any more (`notOwner`), the owners turned export off (`exportOff`),
 * or the subscription was turned off meanwhile (`disabled`). Failed: the address's answer or the
 * way to it (`invalidUrl`, `blocked`, `unreachable`, `timeout`, `redirect`, `http`).
 */
export type DeliveryCode =
  | "noAccess"
  | "notOwner"
  | "exportOff"
  | "disabled"
  | "invalidUrl"
  | "blocked"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "http";

/**
 * What the event was about beyond its page, kept with the delivery until it is sent (the body is
 * made then, as the subscription's person may see it). `actorId`: who did it (null when nobody
 * did, like the trash emptying itself). Edits: whether the title and the body changed. Moves:
 * where the page was. Deletions: the page's title and kind, as it can't be read any more, and
 * whether the person could open it right before. Comments: the thread, the comment and its text.
 */
export type DeliveryDetails = {
  actorId?: string | null;
  title?: boolean;
  body?: boolean;
  from?: { parentId: string | null; teamspaceId: string | null };
  deleted?: { title: string; kind: string; visible: boolean };
  comment?: { threadId: string; commentId: string; reply: boolean; text?: string };
};

/** Subscriptions a workspace may have. */
export const MAX_PAGE_WEBHOOKS = 25;
export const MAX_PAGE_WEBHOOK_NAME = 100;
/** How long the delivery log keeps a delivery. */
export const DELIVERY_LOG_DAYS = 30;
/** The most of a page's Markdown body a delivery carries; longer bodies are cut and marked. */
export const MAX_PAYLOAD_MARKDOWN = 100_000;
/** A new page's delivery waits this long, so a body written right after it is made goes with it. */
export const CREATED_DELAY_MS = 5_000;

/**
 * A subscription's events as stored: known ones only, once each, in the catalog's order; null
 * when none is left.
 */
export function normalizeEvents(events: readonly unknown[]): PageWebhookEvent[] | null {
  const chosen = new Set(events.filter(isPageWebhookEvent));
  const out = PAGE_WEBHOOK_EVENTS.filter((e) => chosen.has(e));
  return out.length ? out : null;
}

/** Whether a failed delivery's code means the address may answer another time (see automations' retriable). */
export const retriableCode = (code: DeliveryCode) => code === "unreachable" || code === "timeout" || code === "http";
