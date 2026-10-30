/**
 * Email on database rows: members connect their own mailboxes in a workspace, mail whose other party
 * is a row's email address lands on that row, and replies go out from one of the member's mailboxes
 * (see server/row-mail). Shared by the client and the server.
 */

export type MailboxStatus = "connecting" | "ok" | "error";
/** How a mailbox signs in: a password (an app password, mostly), or a Google sign-in. */
export type MailboxAuth = "password" | "google";
export type RowEmailDirection = "in" | "out";
export type RowEmailStatus = "received" | "hidden" | "queued" | "sent" | "failed";

/** Where reading stopped in a watched folder: messages after `lastUid` are new. */
export type FolderState = { path: string; uidValidity: string; lastUid: number };
export type MailboxFolders = { inbox?: FolderState; sent?: FolderState };

/** A mailbox's server settings as entered (the password apart). */
export type MailboxServers = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
};

/** Providers whose server settings are filled in from the address's domain. */
export const MAIL_PROVIDERS: { id: string; name: string; domains: string[]; servers: MailboxServers }[] = [
  {
    id: "google",
    name: "Google Workspace / Gmail",
    domains: ["gmail.com", "googlemail.com"],
    servers: { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true },
  },
  {
    id: "yandex",
    name: "Yandex",
    domains: ["yandex.com", "yandex.com.tr", "yandex.ru"],
    servers: { imapHost: "imap.yandex.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.yandex.com", smtpPort: 465, smtpSecure: true },
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    servers: { imapHost: "imap.zoho.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.zoho.com", smtpPort: 465, smtpSecure: true },
  },
];

/** Mailboxes a member may connect in a workspace. */
export const MAX_MAILBOXES = 5;
/** The largest message taken onto a row, attachments included. */
export const MAX_MAIL_BYTES = 25 * 1024 * 1024;
/** Messages a mailbox may send in an hour. */
export const MAX_SENDS_PER_HOUR = 100;
/** How often an outgoing message is tried, and how long to wait before each retry. */
export const SEND_RETRY_MINUTES = [1, 5, 30];
/** Characters of a message's text kept on the row. */
export const MAX_MAIL_TEXT = 200_000;
/** Messages a row's email section loads at a time. */
export const ROW_EMAIL_PAGE = 20;

/** An address as compared: trimmed, without `mailto:` and angle brackets, lower case. Null if it isn't one. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^<(.*)>$/, "$1")
    .trim()
    .toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(address) ? address : null;
}

/** The message ids in a `References` or `In-Reply-To` header, in order, without brackets. */
export function parseMessageIds(header: string | string[] | null | undefined): string[] {
  const text = Array.isArray(header) ? header.join(" ") : (header ?? "");
  const ids = [...text.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
  return ids.length ? ids : text.split(/\s+/).filter((part) => part.includes("@"));
}

/** A message id without its angle brackets, as stored. */
export const bareMessageId = (id: string) => id.trim().replace(/^<|>$/g, "");

/** The server settings of a known provider for an address, if its domain is one. */
export function providerFor(address: string) {
  const domain = address.split("@")[1]?.toLowerCase();
  return domain ? MAIL_PROVIDERS.find((p) => p.domains.includes(domain)) : undefined;
}

/** "Re: " in front of a subject, once. */
export function replySubject(subject: string) {
  return /^\s*(re|aw|sv|ynt)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** A reply's quoted body: the earlier message's lines after a "> ", under who wrote it and when. */
export function quoteText(text: string, header: string) {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return `${header}\n${lines.map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`)).join("\n")}`;
}

/** Whether a message was written by a machine: auto-replies and bulk mail start no automations. */
export function isAutomated(headers: { autoSubmitted?: string | null; precedence?: string | null }) {
  const auto = headers.autoSubmitted?.trim().toLowerCase();
  const precedence = headers.precedence?.trim().toLowerCase();
  return (!!auto && auto !== "no") || precedence === "bulk" || precedence === "list" || precedence === "junk";
}

/** Whether the provider's `Authentication-Results` say the sender's domain did not vouch for it. */
export function dmarcFailed(authenticationResults: string | string[] | null | undefined) {
  const text = Array.isArray(authenticationResults) ? authenticationResults.join(";") : (authenticationResults ?? "");
  return /\bdmarc=(fail|reject|quarantine)\b/i.test(text);
}

/** An email row as the client shows it. */
export type RowEmailView = {
  id: string;
  direction: RowEmailDirection;
  status: RowEmailStatus;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  sentAt: string;
  unverifiedSender: boolean;
  error: string | null;
  sentBy: { id: string; name: string; image: string | null } | null;
  attachments: { fileId: string; name: string; url: string; contentId: string | null }[];
  /** Whether the viewer may hide it from the row (the mailbox's owner, or full access to the database). */
  canHide: boolean;
  /** The viewer's own mailbox it came through or went out of, which a reply goes out from. */
  ownMailboxId: string | null;
};

/** A member's mailbox as its owner sees it in settings (never the password). */
export type MailboxView = {
  id: string;
  address: string;
  displayName: string | null;
  /** The one mail goes out from unless another is picked: follow-ups, agents and email drafts always do. */
  isDefault: boolean;
  servers: MailboxServers;
  username: string;
  auth: MailboxAuth;
  /** The folders read, as the server names them; no sent folder means only incoming mail is read. */
  folders: { inbox: string | null; sent: string | null };
  status: MailboxStatus;
  statusError: string | null;
  syncedAt: string | null;
  /** Follow-ups (lib/sequences.ts): the most they send from it in a day, and the time zone their send window reads in. */
  followUpDailyLimit: number;
  timeZone: string;
};

/** The workspace's email settings as the settings section shows them. */
export type MailSettingsView = {
  enabled: boolean;
  canManage: boolean;
  databases: { databaseId: string; title: string; icon: string | null; propertyIds: string[]; emailProperties: { id: string; name: string }[] }[];
  /** Databases with an email property that aren't matched yet, for owners to add. */
  candidates: { databaseId: string; title: string; icon: string | null }[];
  /** The mailboxes members connected, for owners: whose and how each is doing, nothing more. */
  members: { mailboxId: string; userId: string; name: string; address: string; status: MailboxStatus }[];
};

/**
 * The person's mailboxes in one of their workspaces, as their account lists them: where email on
 * rows is on, or where some are still connected after it was turned off (to disconnect them).
 */
export type OwnMailbox = {
  workspaceId: string;
  workspaceName: string;
  /** Whether the workspace has email on rows on: only then can a mailbox be connected or changed. */
  enabled: boolean;
  /** Whether the server can connect a Gmail or Google Workspace mailbox by signing in with Google. */
  google: boolean;
  /** The default first, then in the order they were connected. */
  mailboxes: MailboxView[];
};

/** The link fragment that opens a message in its row's email section. */
export const rowEmailHash = (rowEmailId: string) => `#email-${rowEmailId}`;
/** The message a link fragment opens, if it is one (see rowEmailHash). */
export const rowEmailFromHash = (hash: string) => /^#email-([\w-]+)$/.exec(hash)?.[1] ?? null;

/** Header fields of a raw header block, unfolded, by lower-case name. */
export function parseHeaderBlock(raw: Buffer | string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const text = (typeof raw === "string" ? raw : (raw?.toString("utf8") ?? "")).replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return out;
}
