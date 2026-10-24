/**
 * Push notifications, the parts that need no server: the VAPID settings, the shape of a browser's
 * subscription, and what a push message says about a notification (see server/push.ts).
 */

import { agentMemoryPath, agentRunPath } from "./agents";
import { commentHash } from "./comments";
import { rowEmailHash } from "./mail";
import { reviewPath } from "./pending-changes";
import { canSnooze } from "./snooze";
import type { SuggestionNotice } from "./suggestions";
import { isTimeZone } from "./time-zone";

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

/**
 * What a push message carries: the notification's two lines in the inbox, where it leads, and the
 * labels of its buttons: Mark as read, and Snooze (empty for what can't be snoozed).
 */
export type PushPayload = { title: string; body: string; url: string; tag: string; read: string; snooze: string };

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
  threadId?: string | null;
  databaseTitle: string | null;
  propertyName: string | null;
  reminderDate: string | null;
  reminderTimeZone: string | null;
  automationName: string | null;
  /** Automations: the message their notify step wrote. Sensitive content: the kind found. */
  automationMessage?: string | null;
  accessRequest: { requesterEmail: string; level: "view" | "comment" | "edit" } | null;
  requestKind: string | null;
  requestEmail: string | null;
  approval: { agentId: string; runId: string; agentName: string; tool: string; connectionName: string } | null;
  memory: { agentId: string; agentName: string; count: number } | null;
  report: { agentId: string; runId: string; agentName: string; status: string } | null;
  /** Row updates: which values changed (a null property is the title), and whether the body. */
  rowUpdate: { changes: { property: { name: string } | null }[]; body: boolean } | null;
  /** Row emails: the message and who it is from. */
  rowEmail?: { id: string; from: string } | null;
  /** Changes waiting for review: how many. */
  review?: { count: number } | null;
  /** Follow-ups: the sequence whose next email needs a look. */
  followUp?: { sequence: string } | null;
  /** Reactions: with what, and who reacted (the latest first). */
  reaction?: { emojis: string[]; people: { name: string }[] } | null;
  /** Comments about a suggested edit: what became of it. */
  suggestion?: SuggestionNotice | null;
  /** When it was recorded: a verification reminder recorded at or after its date says the verification ended. */
  createdAt?: Date | string;
};

/** The line of a comment notification about a suggested edit, in the inbox and in push messages. */
export const SUGGESTION_LINES = {
  suggested: "suggested",
  accepted: "suggestionAccepted",
  rejected: "suggestionRejected",
} as const satisfies Record<SuggestionNotice, string>;

/** The texts of a push message (`push` in email.json), already in the recipient's language. */
export type PushTranslator = (key: string, values?: Record<string, string | number>) => string;

/** Where opening the notification leads: the same place the inbox does. */
export function pushLink(item: PushItem): string {
  if (item.kind === "agent_approval") {
    return `/w/${item.workspaceId}/settings?tab=agents${item.approval ? `&agent=${item.approval.agentId}&run=${item.approval.runId}` : ""}`;
  }
  if (item.kind === "agent_memory") return item.memory ? agentMemoryPath(item.workspaceId, item.memory.agentId) : `/w/${item.workspaceId}/settings?tab=agents`;
  if (item.kind === "agent_report") return item.report ? agentRunPath(item.workspaceId, item.report.agentId, item.report.runId) : `/w/${item.workspaceId}/settings?tab=agents`;
  if (item.kind === "review") return reviewPath(item.workspaceId);
  // The workspace's AI account is chosen in Settings > General.
  if (item.kind === "ai_account_detached") return `/w/${item.workspaceId}/settings`;
  // Findings are reviewed, and dismissed, in Settings > Security.
  if (item.kind === "sensitive_content") return `/w/${item.workspaceId}/settings?tab=security#setting-sensitiveFindings`;
  if (item.pageId === null) return `/w/${item.workspaceId}/settings?tab=members&view=requests`;
  if (item.kind === "row_email" && item.rowEmail) return `/w/${item.workspaceId}/p/${item.pageId}${rowEmailHash(item.rowEmail.id)}`;
  return `/w/${item.workspaceId}/p/${item.pageId}${(item.kind === "comment" || item.kind === "reaction") && item.threadId ? commentHash(item.threadId) : ""}`;
}

/** The zone a reminder's time reads in: the one stored with the reminder, UTC without a valid one. */
const reminderZone = (item: PushItem) => (isTimeZone(item.reminderTimeZone) ? item.reminderTimeZone : "UTC");

/**
 * A push message about an inbox item: the two lines the inbox shows for it (the page, or what
 * the notification is about, then who did what), opening where the inbox opens it. Null for an
 * agent's call that no longer waits. `formatDate` writes a reminder's date in the recipient's
 * language, a time on the clock of `timeZone`: the reminder's zone, UTC when it has none.
 */
export function pushPayload(
  item: PushItem,
  t: PushTranslator,
  formatDate: (isoDate: string, timeZone: string) => string,
): PushPayload | null {
  const actor = item.actorName || t("someone");
  let title: string;
  let line: string;
  if (item.kind === "agent_approval") {
    if (!item.approval) return null;
    title = t("approvalTitle", { agent: item.approval.agentName || actor });
    line = t("approval", { tool: item.approval.tool, connection: item.approval.connectionName });
  } else if (item.kind === "agent_memory") {
    // Not what the notes say: a lock screen shows it to whoever holds the device.
    if (!item.memory) return null;
    title = t("memoryTitle", { agent: item.memory.agentName || actor });
    line = t("memory", { count: item.memory.count });
  } else if (item.kind === "agent_report") {
    // Not what the report says either: it may quote the database.
    if (!item.report) return null;
    title = t("reportTitle", { agent: item.report.agentName || actor });
    line = item.report.status === "failed" ? t("reportFailed") : t("reportDone");
  } else if (item.kind === "review") {
    // How many, not what they change: a lock screen shows it to whoever holds the device.
    title = t("reviewTitle");
    line = t("review", { count: item.review?.count ?? 1, agent: actor });
  } else if (item.kind === "ai_account_detached") {
    title = t("aiAccountTitle");
    line = t("aiAccountDetached", { actor });
  } else if (item.kind === "sensitive_content") {
    // The page's title, and what kind of thing: never the value, not even masked.
    title = item.pageTitle?.trim() || t("untitled");
    line = t("sensitiveContent", { kind: item.automationMessage ?? "" });
  } else if (item.kind === "join_request") {
    title = t("joinRequestTitle");
    line = item.requestKind === "invite" ? t("inviteRequest", { actor, email: item.requestEmail ?? "" }) : t("joinRequest", { actor });
  } else {
    title = item.pageTitle?.trim() || t("untitled");
    switch (item.kind) {
      case "access_request":
        {
          const asker = item.actorName || item.accessRequest?.requesterEmail || t("someone");
          const level = item.accessRequest?.level ?? "view";
          line = level === "view" ? t("accessRequest", { actor: asker }) : t("accessRequestMore", { actor: asker, level });
        }
        break;
      case "page_shared":
        line = t("pageShared", { actor });
        break;
      case "comment":
        line = item.suggestion ? t(SUGGESTION_LINES[item.suggestion], { actor }) : t("comment", { actor });
        break;
      case "mention":
        line = t("mention", { actor });
        break;
      case "reminder":
        line = t("reminder", { date: item.reminderDate ? formatDate(item.reminderDate, reminderZone(item)) : "" });
        break;
      case "automation":
        // No automation: someone clicked a button on the page (server/buttons.ts).
        line = item.reminderDate
          ? t("automationDatePassed", { name: item.automationName ?? "" })
          : item.automationName === null
            ? t("button", { actor })
            : t("automation", { name: item.automationName, actor });
        break;
      case "row_update": {
        // Which values changed, not what to: a lock screen shows it to whoever holds the device.
        const fields = [
          ...(item.rowUpdate?.changes ?? []).map((c) => (c.property ? c.property.name.trim() || t("untitled") : t("rowUpdateTitle"))),
          ...(item.rowUpdate?.body ? [t("rowUpdateBody")] : []),
        ];
        line = fields.length ? t("rowUpdate", { actor, fields: fields.join(", ") }) : t("rowUpdateSome", { actor });
        break;
      }
      case "page_updated":
        line = t("pageUpdated", { actor });
        break;
      case "follow_up":
        line = t("followUp", { sequence: item.followUp?.sequence ?? "" });
        break;
      case "reaction":
        // Not the comment: a lock screen shows it to whoever holds the device.
        line = t("reaction", {
          actor: t("people", { name: item.reaction?.people[0]?.name || actor, others: Math.max(0, (item.reaction?.people.length ?? 1) - 1) }),
          emoji: item.reaction?.emojis.join(" ") ?? "",
        });
        break;
      case "verification": {
        // Recorded at or after the end: it ended; before it: it ends soon.
        const ended = item.reminderDate !== null && new Date(item.createdAt ?? Date.now()) >= new Date(item.reminderDate);
        line = t(ended ? "verificationEnded" : "verificationEnds", { date: item.reminderDate ? formatDate(item.reminderDate, reminderZone(item)) : "" });
        break;
      }
      case "row_email":
        // Who wrote, not the subject: a lock screen shows it to whoever holds the device.
        line = t("rowEmail", { from: item.rowEmail?.from || t("someone") });
        break;
      default:
        line = t("assignment", { actor, property: item.propertyName ?? "" });
    }
    if (item.databaseTitle !== null) line += ` · ${item.databaseTitle.trim() || t("untitled")}`;
  }
  // An agent's call waits only so long: snoozing it would let it run out unseen.
  return { title, body: line, url: pushLink(item), tag: item.id, read: t("read"), snooze: canSnooze(item.kind) ? t("snooze") : "" };
}
