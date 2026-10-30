import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, mailbox, mailboxOauth, mailDatabase, page, user } from "@/db/schema";
import { env } from "@/lib/env";
import { MAX_DAILY_LIMIT } from "@/lib/sequences";
import { isTimeZone } from "@/lib/time-zone";
import { MAX_MAILBOXES, normalizeAddress, type MailboxAuth, type MailboxFolders, type MailboxServers, type MailboxView, type MailSettingsView, type OwnMailbox } from "@/lib/mail";
import { isGuest, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { open, openJson, seal, sealJson } from "@/server/secret-box";
import { listWorkspaces, workspaceSettings } from "@/server/workspaces";
import { MailConnectError, testMailbox, type MailCredentials } from "./connect";
import { exchangeGoogleCode, GOOGLE_MAIL, googleAuthorizationUrl, GoogleSignInError, pkce } from "./google";

/**
 * Settings > General > Email: owners choose the databases mail lands on, in order, and which of their email
 * properties hold the other party's address; every member (not guests) connects their own mailboxes
 * in the workspace from their account (Account > Email and calendar), each tried before it is kept:
 * with a password, or by signing in with Google (beginGoogleMailbox, then completeGoogleMailbox).
 * One address is one mailbox (connecting it again changes it), and one of a member's mailboxes is
 * their default: the first one connected, then whichever they pick, then the oldest left.
 */

export type RowMailErrorCode =
  | "disabled"
  | "invalid"
  | "consent"
  | "noMailbox"
  | "rateLimited"
  | "gone"
  | "googleFailed"
  | "googleScope"
  | "tooMany"
  | "alreadyConnected"
  | MailConnectError["code"];

export class RowMailError extends Error {
  constructor(readonly code: RowMailErrorCode) {
    super(code);
  }
}

/** The most databases mail is matched to in a workspace. */
const MAX_MAIL_DATABASES = 20;

function mailboxView(m: typeof mailbox.$inferSelect): MailboxView {
  return {
    id: m.id,
    address: m.address,
    displayName: m.displayName,
    isDefault: m.isDefault,
    servers: {
      imapHost: m.imapHost,
      imapPort: m.imapPort,
      imapSecure: m.imapSecure,
      smtpHost: m.smtpHost,
      smtpPort: m.smtpPort,
      smtpSecure: m.smtpSecure,
    },
    username: m.username,
    auth: m.auth,
    folders: { inbox: m.folders.inbox?.path ?? null, sent: m.folders.sent?.path ?? null },
    status: m.status,
    statusError: m.statusError,
    syncedAt: m.syncedAt?.toISOString() ?? null,
    followUpDailyLimit: m.followUpDailyLimit,
    timeZone: m.timeZone,
  };
}

/** The databases of the workspace with email properties, each with them. */
async function emailDatabases(workspaceId: string) {
  const rows = await db
    .select({ databaseId: page.id, title: page.title, icon: page.icon, propertyId: databaseProperty.id, propertyName: databaseProperty.name })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(page.kind, "database"),
        isNull(page.archivedAt),
        eq(databaseProperty.type, "email"),
        isNull(databaseProperty.deletedAt),
      ),
    )
    .orderBy(asc(page.title), asc(databaseProperty.position));
  const out = new Map<string, { title: string; icon: string | null; properties: { id: string; name: string }[] }>();
  for (const r of rows) {
    const entry = out.get(r.databaseId) ?? { title: r.title, icon: r.icon, properties: [] };
    entry.properties.push({ id: r.propertyId, name: r.propertyName });
    out.set(r.databaseId, entry);
  }
  return out;
}

export async function getMailSettings(userId: string, workspaceId: string): Promise<MailSettingsView> {
  const membership = await requireMembership(userId, workspaceId);
  const canManage = membership.role === "owner";
  const settings = await workspaceSettings(workspaceId);
  const view: MailSettingsView = { enabled: settings.email, canManage, databases: [], candidates: [], members: [] };
  if (!canManage) return view;
  const [chosen, available, boxes] = await Promise.all([
    db
      .select({ databaseId: mailDatabase.databaseId, propertyIds: mailDatabase.propertyIds })
      .from(mailDatabase)
      .where(eq(mailDatabase.workspaceId, workspaceId))
      .orderBy(asc(mailDatabase.position), asc(mailDatabase.createdAt)),
    emailDatabases(workspaceId),
    db
      .select({ mailboxId: mailbox.id, userId: mailbox.userId, name: user.name, address: mailbox.address, status: mailbox.status })
      .from(mailbox)
      .innerJoin(user, eq(user.id, mailbox.userId))
      .where(eq(mailbox.workspaceId, workspaceId))
      .orderBy(asc(user.name), desc(mailbox.isDefault), asc(mailbox.createdAt)),
  ]);
  for (const c of chosen) {
    const database = available.get(c.databaseId);
    if (!database) continue;
    view.databases.push({
      databaseId: c.databaseId,
      title: database.title,
      icon: database.icon,
      propertyIds: c.propertyIds.filter((id) => database.properties.some((p) => p.id === id)),
      emailProperties: database.properties,
    });
  }
  const taken = new Set(chosen.map((c) => c.databaseId));
  view.candidates = [...available].filter(([id]) => !taken.has(id)).map(([databaseId, d]) => ({ databaseId, title: d.title, icon: d.icon }));
  view.members = boxes;
  return view;
}

/**
 * The person's own mailboxes (Account > Email and calendar), by workspace they are a member of (not
 * a guest) where email on rows is on or a mailbox of theirs is still connected.
 */
export async function listOwnMailboxes(userId: string): Promise<OwnMailbox[]> {
  const [workspaces, boxes] = await Promise.all([
    listWorkspaces(userId),
    db.select().from(mailbox).where(eq(mailbox.userId, userId)).orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt)),
  ]);
  const members = workspaces.filter((w) => !isGuest(w.role));
  const settings = await Promise.all(members.map((w) => workspaceSettings(w.id)));
  return members.flatMap((w, i) => {
    const own = boxes.filter((b) => b.workspaceId === w.id);
    const enabled = settings[i].email;
    return enabled || own.length ? [{ workspaceId: w.id, workspaceName: w.name, enabled, google: !!env.mailGoogleApp, mailboxes: own.map(mailboxView) }] : [];
  });
}

/**
 * Sets the databases mail lands on, in order, each with the email properties holding addresses
 * (owners only). Databases left out stop getting mail; their messages stay on their rows.
 */
export async function setMailDatabases(userId: string, workspaceId: string, entries: { databaseId: string; propertyIds: string[] }[]) {
  await requireMembership(userId, workspaceId, "owner");
  if (!Array.isArray(entries) || entries.length > MAX_MAIL_DATABASES) throw new RowMailError("invalid");
  const available = await emailDatabases(workspaceId);
  const seen = new Set<string>();
  const values = entries.map((entry, position) => {
    const database = typeof entry?.databaseId === "string" ? available.get(entry.databaseId) : undefined;
    if (!database || seen.has(entry.databaseId) || !Array.isArray(entry.propertyIds)) throw new RowMailError("invalid");
    seen.add(entry.databaseId);
    // "*": every email property of the database (as one is added).
    const wanted = entry.propertyIds.includes("*") ? database.properties.map((p) => p.id) : entry.propertyIds;
    const propertyIds = [...new Set(wanted)].filter((id) => database.properties.some((p) => p.id === id));
    if (!propertyIds.length) throw new RowMailError("invalid");
    return { databaseId: entry.databaseId, workspaceId, propertyIds, position, title: database.title };
  });
  await db.transaction(async (tx) => {
    await tx
      .delete(mailDatabase)
      .where(
        and(
          eq(mailDatabase.workspaceId, workspaceId),
          values.length
            ? notInArray(
                mailDatabase.databaseId,
                values.map((v) => v.databaseId),
              )
            : undefined,
        ),
      );
    for (const { title: _title, ...value } of values) {
      await tx
        .insert(mailDatabase)
        .values(value)
        .onConflictDoUpdate({ target: mailDatabase.databaseId, set: { propertyIds: value.propertyIds, position: value.position } });
    }
  });
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "mail.databases_changed",
    target: { type: "workspace", id: workspaceId },
    details: { names: values.map((v) => v.title) },
  });
}

export type MailboxInput = {
  /** The mailbox being changed; none to connect another (or to change the one with this address). */
  mailboxId?: string | null;
  address: string;
  displayName?: string | null;
  servers: MailboxServers;
  username: string;
  /** Empty to keep the password of the mailbox already connected. */
  password: string;
  /** The member agreed that mail matched to rows shows to everyone who sees those rows. */
  consent: boolean;
  /** The member's IANA time zone, which follow-ups' send windows read in (kept when not given). */
  timeZone?: string | null;
};

const host = (value: unknown) => typeof value === "string" && /^[a-z0-9.\-[\]:]{1,253}$/i.test(value.trim());
const port = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;

function cleanServers(servers: MailboxServers): MailboxServers {
  if (!servers || !host(servers.imapHost) || !host(servers.smtpHost) || !port(servers.imapPort) || !port(servers.smtpPort)) {
    throw new RowMailError("invalid");
  }
  return {
    imapHost: servers.imapHost.trim().toLowerCase(),
    imapPort: servers.imapPort,
    imapSecure: servers.imapSecure === true,
    smtpHost: servers.smtpHost.trim().toLowerCase(),
    smtpPort: servers.smtpPort,
    smtpSecure: servers.smtpSecure === true,
  };
}

/**
 * Connects one of the member's mailboxes in the workspace, or changes it: signs in to both servers
 * first and keeps it only when that works. Reading starts from now; on the same account, from where
 * it was.
 */
export async function connectMailbox(userId: string, workspaceId: string, input: MailboxInput): Promise<MailboxView> {
  await requireMailboxPlace(userId, workspaceId);
  if (input?.consent !== true) throw new RowMailError("consent");
  const address = normalizeAddress(input.address);
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim().slice(0, 200) || null : null;
  if (!address || !username || username.length > 320 || password.length > 1024) throw new RowMailError("invalid");
  const servers = cleanServers(input.servers);
  const existing = await mailboxToSave(userId, workspaceId, address, input.mailboxId);
  // A Google mailbox changed to a password gives one; its sealed tokens are no password.
  const secret = password ? password : existing?.auth === "password" ? open(existing.secret) : "";
  if (!secret) throw new RowMailError("invalid");
  return saveMailbox(existing, {
    workspaceId,
    userId,
    address,
    displayName,
    credentials: { servers, username, password: secret },
    auth: "password",
    secret: seal(secret),
    timeZone: input.timeZone,
  });
}

/**
 * Which of the member's mailboxes in the workspace a connection to `address` changes: the one with
 * that address, or `mailboxId` (whose address it then changes); none when it is another one, which
 * the member may connect while they have fewer than MAX_MAILBOXES.
 */
async function mailboxToSave(userId: string, workspaceId: string, address: string, mailboxId: string | null | undefined) {
  const own = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)));
  const same = own.find((m) => m.address === address);
  if (typeof mailboxId === "string") {
    const changed = own.find((m) => m.id === mailboxId);
    if (!changed) throw new RowMailError("gone");
    if (same && same.id !== changed.id) throw new RowMailError("alreadyConnected");
    return changed;
  }
  if (same) return same;
  if (own.length >= MAX_MAILBOXES) throw new RowMailError("tooMany");
  return undefined;
}

/** Members (not guests) of a workspace with email on rows on may connect a mailbox there. */
async function requireMailboxPlace(userId: string, workspaceId: string) {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) throw new RowMailError("invalid");
  if (!(await workspaceSettings(workspaceId)).email) throw new RowMailError("disabled");
}

/**
 * Tries a mailbox and keeps it, in place of `existing` (one of the member's mailboxes in the
 * workspace) or as another; the first one is their default. Reading starts from now; on the same
 * account, from where it was.
 */
async function saveMailbox(
  existing: typeof mailbox.$inferSelect | undefined,
  input: {
    workspaceId: string;
    userId: string;
    address: string;
    displayName: string | null;
    credentials: MailCredentials;
    auth: MailboxAuth;
    /** The password or the tokens, sealed. */
    secret: string;
    timeZone?: string | null;
  },
): Promise<MailboxView> {
  const { workspaceId, userId, address, credentials } = input;
  const { servers, username } = credentials;
  let folders: MailboxFolders;
  try {
    folders = await testMailbox(credentials);
  } catch (error) {
    throw new RowMailError(error instanceof MailConnectError ? error.code : "unreachable");
  }
  // The same account again: carry on from where reading stopped, so nothing in between is missed.
  if (existing && existing.imapHost === servers.imapHost && existing.username.toLowerCase() === username.toLowerCase()) {
    for (const key of ["inbox", "sent"] as const) {
      const before = existing.folders[key];
      const now = folders[key];
      if (before && now && before.path === now.path && before.uidValidity === now.uidValidity) folders[key] = before;
    }
  }
  const values = {
    workspaceId,
    userId,
    address,
    displayName: input.displayName,
    ...servers,
    username,
    auth: input.auth,
    secret: input.secret,
    folders,
    status: "ok" as const,
    statusError: null,
    consentedAt: new Date(),
    ...(isTimeZone(input.timeZone) ? { timeZone: input.timeZone } : {}),
  };
  const [saved] = existing
    ? await db
        .update(mailbox)
        .set({ ...values, syncedAt: null })
        .where(eq(mailbox.id, existing.id))
        .returning()
    : await db
        .insert(mailbox)
        .values({
          ...values,
          isDefault: sql`not exists (select 1 from ${mailbox} where ${mailbox.workspaceId} = ${workspaceId} and ${mailbox.userId} = ${userId} and ${mailbox.isDefault})`,
        })
        .onConflictDoUpdate({ target: [mailbox.workspaceId, mailbox.userId, mailbox.address], set: { ...values, syncedAt: null } })
        .returning();
  if (!saved) throw new RowMailError("gone");
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "mail.mailbox_connected",
    target: { type: "mailbox", id: saved.id, label: address },
    details: { auth: input.auth },
  });
  return mailboxView(saved);
}

/** A Google sign-in begun is void after this long. */
const GOOGLE_STATE_MS = 15 * 60_000;

export const mailOAuthRedirectUrl = () => `${env.appUrl}/api/mail/oauth/callback`;

/**
 * Begins connecting one of the member's mailboxes in the workspace by signing in with Google
 * (`mailboxId`: the one it changes): returns the address to send the browser to. The consent, time
 * zone, name on outgoing mail and mailbox are kept with the sign-in until it comes back; `address`,
 * when typed, picks the Google account.
 */
export async function beginGoogleMailbox(
  userId: string,
  workspaceId: string,
  input: { consent: boolean; timeZone?: string | null; displayName?: string | null; address?: string | null; mailboxId?: string | null },
): Promise<{ url: string }> {
  await requireMailboxPlace(userId, workspaceId);
  if (input?.consent !== true) throw new RowMailError("consent");
  const app = env.mailGoogleApp;
  if (!app) throw new RowMailError("invalid");
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkce();
  const timeZone = isTimeZone(input.timeZone) ? input.timeZone : null;
  const displayName = typeof input.displayName === "string" ? input.displayName.trim().slice(0, 200) || null : null;
  await db.delete(mailboxOauth).where(lt(mailboxOauth.createdAt, new Date(Date.now() - GOOGLE_STATE_MS)));
  const mailboxId = typeof input.mailboxId === "string" ? input.mailboxId : null;
  await db.insert(mailboxOauth).values({ state, userId, workspaceId, data: sealJson({ verifier, consent: true, timeZone, displayName, mailboxId }) });
  return { url: googleAuthorizationUrl(app, { state, challenge, redirectUri: mailOAuthRedirectUrl(), loginHint: normalizeAddress(input.address) }) };
}

/** The workspace a Google sign-in begun with `state` (by `userId`, when given) came from, to send the browser back to. */
export async function googleMailReturnOf(state: string, userId?: string): Promise<{ workspaceId: string } | null> {
  const [pending] = await db
    .select({ workspaceId: mailboxOauth.workspaceId })
    .from(mailboxOauth)
    .where(and(eq(mailboxOauth.state, state), userId === undefined ? undefined : eq(mailboxOauth.userId, userId)));
  return pending ?? null;
}

/**
 * The browser came back from Google: finishes the sign-in begun with `state` by the same person,
 * tries the mailbox with it (Gmail's servers, XOAUTH2) and keeps it, in place of the one it was
 * begun for or the one with that address, or as another. The sign-in is used up whether or not
 * this works.
 */
export async function completeGoogleMailbox(userId: string, input: { state: string; code: string }): Promise<{ workspaceId: string; mailbox: MailboxView }> {
  const [pending] = await db
    .delete(mailboxOauth)
    .where(and(eq(mailboxOauth.state, input.state), eq(mailboxOauth.userId, userId)))
    .returning();
  if (!pending || pending.createdAt.getTime() < Date.now() - GOOGLE_STATE_MS) throw new RowMailError("googleFailed");
  const { verifier, consent, timeZone, displayName, mailboxId } = openJson<{
    verifier: string;
    consent?: boolean;
    timeZone?: string | null;
    displayName?: string | null;
    mailboxId?: string | null;
  }>(pending.data);
  if (consent !== true) throw new RowMailError("consent");
  const { workspaceId } = pending;
  await requireMailboxPlace(userId, workspaceId);
  const app = env.mailGoogleApp;
  if (!app) throw new RowMailError("invalid");
  let signedIn: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    signedIn = await exchangeGoogleCode(app, { code: input.code, verifier, redirectUri: mailOAuthRedirectUrl() });
  } catch (error) {
    if (error instanceof GoogleSignInError) {
      console.warn("[row-mail] Google sign-in didn't connect a mailbox:", error.message);
      throw new RowMailError(error.reason === "scope" ? "googleScope" : "googleFailed");
    }
    throw error;
  }
  const address = normalizeAddress(signedIn.email);
  if (!address) throw new RowMailError("googleFailed");
  const existing = await mailboxToSave(userId, workspaceId, address, mailboxId);
  const saved = await saveMailbox(existing, {
    workspaceId,
    userId,
    address,
    displayName: displayName || (existing?.address === address ? existing.displayName : null),
    credentials: { servers: GOOGLE_MAIL.servers, username: address, accessToken: signedIn.tokens.accessToken },
    auth: "google",
    secret: sealJson(signedIn.tokens),
    timeZone,
  });
  return { workspaceId, mailbox: saved };
}

/** One of the person's own mailboxes, in a workspace they are still a member of. */
async function requireOwnMailbox(userId: string, mailboxId: string) {
  const [box] = typeof mailboxId === "string" ? await db.select().from(mailbox).where(and(eq(mailbox.id, mailboxId), eq(mailbox.userId, userId))) : [];
  if (!box) throw new RowMailError("noMailbox");
  await requireMembership(userId, box.workspaceId);
  return box;
}

/**
 * How follow-ups send from one of the member's mailboxes: at most `dailyLimit` emails a day, all
 * sequences together, in send windows read in `timeZone`.
 */
export async function setMailboxSending(userId: string, mailboxId: string, input: { dailyLimit: number; timeZone: string }): Promise<MailboxView> {
  await requireOwnMailbox(userId, mailboxId);
  const limit = input?.dailyLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_LIMIT || !isTimeZone(input.timeZone)) throw new RowMailError("invalid");
  const [saved] = await db
    .update(mailbox)
    .set({ followUpDailyLimit: limit, timeZone: input.timeZone })
    .where(and(eq(mailbox.id, mailboxId), eq(mailbox.userId, userId)))
    .returning();
  if (!saved) throw new RowMailError("noMailbox");
  return mailboxView(saved);
}

/** Makes one of the member's mailboxes the one mail goes out from unless they pick another; returns all of theirs in the workspace. */
export async function setDefaultMailbox(userId: string, mailboxId: string): Promise<MailboxView[]> {
  const box = await requireOwnMailbox(userId, mailboxId);
  const mine = and(eq(mailbox.workspaceId, box.workspaceId), eq(mailbox.userId, userId));
  await db.transaction(async (tx) => {
    await tx.update(mailbox).set({ isDefault: false }).where(and(mine, eq(mailbox.isDefault, true)));
    await tx.update(mailbox).set({ isDefault: true }).where(eq(mailbox.id, box.id));
  });
  return ownIn(userId, box.workspaceId);
}

/** The member's mailboxes in the workspace, the default first. */
async function ownIn(userId: string, workspaceId: string) {
  const boxes = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)))
    .orderBy(desc(mailbox.isDefault), asc(mailbox.createdAt));
  return boxes.map(mailboxView);
}

/**
 * Disconnects one of the member's mailboxes; the messages it brought stay on their rows. When it
 * was their default, the oldest one left becomes it. Returns the ones left in the workspace.
 */
export async function disconnectMailbox(userId: string, mailboxId: string): Promise<MailboxView[]> {
  const box = await requireOwnMailbox(userId, mailboxId);
  await db.transaction(async (tx) => {
    await tx.delete(mailbox).where(eq(mailbox.id, box.id));
    if (!box.isDefault) return;
    const [{ n }] = await tx
      .select({ n: count() })
      .from(mailbox)
      .where(and(eq(mailbox.workspaceId, box.workspaceId), eq(mailbox.userId, userId), eq(mailbox.isDefault, true)));
    if (n) return;
    const [oldest] = await tx
      .select({ id: mailbox.id })
      .from(mailbox)
      .where(and(eq(mailbox.workspaceId, box.workspaceId), eq(mailbox.userId, userId)))
      .orderBy(asc(mailbox.createdAt))
      .limit(1);
    if (oldest) await tx.update(mailbox).set({ isDefault: true }).where(eq(mailbox.id, oldest.id));
  });
  await recordAudit({
    workspaceId: box.workspaceId,
    actorId: userId,
    action: "mail.mailbox_disconnected",
    target: { type: "mailbox", id: box.id, label: box.address },
  });
  return ownIn(userId, box.workspaceId);
}

/** Drops the mailboxes of people who left these workspaces (their passwords leave with them). */
export async function dropMailboxes(workspaceId: string, userIds: string[]) {
  if (!userIds.length) return;
  await db.delete(mailbox).where(and(eq(mailbox.workspaceId, workspaceId), inArray(mailbox.userId, userIds)));
}
