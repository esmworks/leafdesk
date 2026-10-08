/**
 * Push notifications, the parts that need no server: the VAPID settings, the shape of a browser's
 * subscription, and what a push message says about a notification (see server/push.ts).
 */

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Bytes of a base64url text, or null when it isn't one. */
export function base64UrlBytes(value: string): number | null {
  if (!BASE64URL.test(value)) return null;
  const length = Math.floor((value.length * 3) / 4);
  return value.length % 4 === 1 ? null : length;
}

/**
 * The server's VAPID keys (`pnpm push:keys` makes a pair): a P-256 public key (65 bytes) and private
 * key (32 bytes) in base64url, and a subject push services can reach the administrator at
 * (`mailto:` or `https:`). Null unless all three are set and well-formed: push is then off.
 */
export function vapidFrom(source: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = source.VAPID_PUBLIC_KEY?.trim().replace(/=+$/, "");
  const privateKey = source.VAPID_PRIVATE_KEY?.trim().replace(/=+$/, "");
  const subject = source.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (base64UrlBytes(publicKey) !== 65 || base64UrlBytes(privateKey) !== 32) return null;
  if (!/^mailto:\S+@\S+$/i.test(subject) && !/^https:\/\/\S+$/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** Longest endpoint a browser's subscription may have (the ones in use are well under 1 KB). */
export const MAX_PUSH_ENDPOINT = 2048;

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

/**
 * Checks a subscription a browser sent: an https endpoint (http only for `allowedHosts`) without
 * credentials, and keys of the right sizes (a P-256 public key, a 16-byte secret). Where the
 * endpoint points is checked again before each send (server/push.ts). Null when it isn't valid.
 */
export function parsePushSubscription(input: unknown, allowedHosts: readonly string[] = []): PushSubscriptionInput | null {
  if (!input || typeof input !== "object") return null;
  const { endpoint, p256dh, auth } = input as Record<string, unknown>;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!endpoint || endpoint.length > MAX_PUSH_ENDPOINT) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isAllowedPushHost(url, allowedHosts))) return null;
  const key = p256dh.replace(/=+$/, "");
  const secret = auth.replace(/=+$/, "");
  if (base64UrlBytes(key) !== 65 || base64UrlBytes(secret) !== 16) return null;
  // Kept as the browser wrote it: the browser finds its own subscription by this exact text.
  return { endpoint, p256dh: key, auth: secret };
}

/** Whether `url` is on PUSH_ALLOWED_HOSTS (by host name, or host and port). */
export function isAllowedPushHost(url: URL, allowedHosts: readonly string[]) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowedHosts.includes(host) || allowedHosts.includes(`${host}:${port}`);
}

/** What a push message carries: the notification's two lines in the inbox and where it leads. */
export type PushPayload = { title: string; body: string; url: string; tag: string };

/**
 * Most bytes of a payload. Push services take about 4 KB after encryption; staying well under
 * leaves room for it, and the texts are cut to fit.
 */
export const MAX_PUSH_PAYLOAD = 3_000;
const MAX_TITLE = 200;
const MAX_BODY = 500;

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The JSON a push message carries, with the title and body shortened until it fits MAX_PUSH_PAYLOAD. */
export function encodePushPayload(payload: PushPayload): string {
  let title = cut(payload.title, MAX_TITLE);
  let body = cut(payload.body, MAX_BODY);
  let json = JSON.stringify({ ...payload, title, body });
  while (byteLength(json) > MAX_PUSH_PAYLOAD && (body.length > 1 || title.length > 1)) {
    if (body.length > 1) body = cut(body, Math.floor(body.length / 2));
    else title = cut(title, Math.floor(title.length / 2));
    json = JSON.stringify({ ...payload, title, body });
  }
  return json;
}

/** What a push message needs to know of an inbox item (server/notifications.ts, InboxItem). */
export type PushItem = {
  id: string;
  kind: string;
  workspaceId: string;
  actorName: string | null;
  pageId: string | null;
  pageTitle: string | null;
  databaseTitle: string | null;
  propertyName: string | null;
  reminderDate: string | null;
  automationName: string | null;
  accessRequest: { requesterEmail: string } | null;
  requestKind: string | null;
  requestEmail: string | null;
  approval: { agentId: string; runId: string; agentName: string; tool: string; connectionName: string } | null;
};

/** The texts of a push message (`push` in email.json), already in the recipient's language. */
export type PushTranslator = (key: string, values?: Record<string, string>) => string;

/** Where opening the notification leads: the same place the inbox does. */
export function pushLink(item: PushItem): string {
  if (item.kind === "agent_approval") {
    return `/w/${item.workspaceId}/settings?tab=agents${item.approval ? `&agent=${item.approval.agentId}&run=${item.approval.runId}` : ""}`;
  }
  if (item.pageId === null) return `/w/${item.workspaceId}/settings?tab=members&view=requests`;
  return `/w/${item.workspaceId}/p/${item.pageId}`;
}

/**
 * A push message about an inbox item: the two lines the inbox shows for it (the page, or what
 * the notification is about, then who did what), opening where the inbox opens it. Null for an
 * agent's call that no longer waits. `formatDate` writes a reminder's date in the recipient's
 * language.
 */
export function pushPayload(item: PushItem, t: PushTranslator, formatDate: (isoDate: string) => string): PushPayload | null {
  const actor = item.actorName || t("someone");
  let title: string;
  let line: string;
  if (item.kind === "agent_approval") {
    if (!item.approval) return null;
    title = t("approvalTitle", { agent: item.approval.agentName || actor });
    line = t("approval", { tool: item.approval.tool, connection: item.approval.connectionName });
  } else if (item.kind === "join_request") {
    title = t("joinRequestTitle");
    line = item.requestKind === "invite" ? t("inviteRequest", { actor, email: item.requestEmail ?? "" }) : t("joinRequest", { actor });
  } else {
    title = item.pageTitle?.trim() || t("untitled");
    switch (item.kind) {
      case "access_request":
        line = t("accessRequest", { actor: item.actorName || item.accessRequest?.requesterEmail || t("someone") });
        break;
      case "page_shared":
        line = t("pageShared", { actor });
        break;
      case "comment":
        line = t("comment", { actor });
        break;
      case "mention":
        line = t("mention", { actor });
        break;
      case "reminder":
        line = t("reminder", { date: item.reminderDate ? formatDate(item.reminderDate) : "" });
        break;
      case "automation":
        line = t("automation", { name: item.automationName ?? "", actor });
        break;
      default:
        line = t("assignment", { actor, property: item.propertyName ?? "" });
    }
    if (item.databaseTitle !== null) line += ` · ${item.databaseTitle.trim() || t("untitled")}`;
  }
  return { title, body: line, url: pushLink(item), tag: item.id };
}
