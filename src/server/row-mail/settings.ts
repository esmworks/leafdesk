import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, mailbox, mailDatabase, page, user } from "@/db/schema";
import { normalizeAddress, type MailboxFolders, type MailboxServers, type MailboxView, type MailSettingsView, type OwnMailbox } from "@/lib/mail";
import { isGuest, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { open, seal } from "@/server/secret-box";
import { listWorkspaces, workspaceSettings } from "@/server/workspaces";
import { MailConnectError, testMailbox } from "./connect";

/**
 * Settings > General > Email: owners choose the databases mail lands on, in order, and which of their email
 * properties hold the other party's address; every member (not guests) connects their own mailbox
 * in the workspace from their account (Account > Email and calendar), which is tried before it is kept.
 */

export type RowMailErrorCode = "disabled" | "invalid" | "consent" | "noMailbox" | "rateLimited" | "gone" | MailConnectError["code"];

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
    servers: {
      imapHost: m.imapHost,
      imapPort: m.imapPort,
      imapSecure: m.imapSecure,
      smtpHost: m.smtpHost,
      smtpPort: m.smtpPort,
      smtpSecure: m.smtpSecure,
    },
    username: m.username,
    folders: { inbox: m.folders.inbox?.path ?? null, sent: m.folders.sent?.path ?? null },
    status: m.status,
    statusError: m.statusError,
    syncedAt: m.syncedAt?.toISOString() ?? null,
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
      .select({ userId: mailbox.userId, name: user.name, address: mailbox.address, status: mailbox.status })
      .from(mailbox)
      .innerJoin(user, eq(user.id, mailbox.userId))
      .where(eq(mailbox.workspaceId, workspaceId))
      .orderBy(asc(user.name)),
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
 * The person's own mailboxes (Account > Email and calendar), one per workspace they are a member
 * of (not a guest) where email on rows is on or a mailbox of theirs is still connected.
 */
export async function listOwnMailboxes(userId: string): Promise<OwnMailbox[]> {
  const [workspaces, boxes] = await Promise.all([
    listWorkspaces(userId),
    db.select().from(mailbox).where(eq(mailbox.userId, userId)),
  ]);
  const members = workspaces.filter((w) => !isGuest(w.role));
  const settings = await Promise.all(members.map((w) => workspaceSettings(w.id)));
  return members.flatMap((w, i) => {
    const own = boxes.find((b) => b.workspaceId === w.id);
    const enabled = settings[i].email;
    return enabled || own ? [{ workspaceId: w.id, workspaceName: w.name, enabled, mailbox: own ? mailboxView(own) : null }] : [];
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
  address: string;
  displayName?: string | null;
  servers: MailboxServers;
  username: string;
  /** Empty to keep the password of the mailbox already connected. */
  password: string;
  /** The member agreed that mail matched to rows shows to everyone who sees those rows. */
  consent: boolean;
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
 * Connects (or changes) the member's mailbox in the workspace: signs in to both servers first and
 * keeps it only when that works. Reading starts from now; on the same account, from where it was.
 */
export async function connectMailbox(userId: string, workspaceId: string, input: MailboxInput): Promise<MailboxView> {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) throw new RowMailError("invalid");
  if (!(await workspaceSettings(workspaceId)).email) throw new RowMailError("disabled");
  if (input?.consent !== true) throw new RowMailError("consent");
  const address = normalizeAddress(input.address);
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim().slice(0, 200) || null : null;
  if (!address || !username || username.length > 320 || password.length > 1024) throw new RowMailError("invalid");
  const servers = cleanServers(input.servers);
  const [existing] = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)));
  const secret = password ? password : existing ? open(existing.secret) : "";
  if (!secret) throw new RowMailError("invalid");
  let folders: MailboxFolders;
  try {
    folders = await testMailbox({ servers, username, password: secret });
  } catch (error) {
    throw new RowMailError(error instanceof MailConnectError ? error.code : "unreachable");
  }
  // The same account again: carry on from where reading stopped, so nothing in between is missed.
  if (existing && existing.imapHost === servers.imapHost && existing.username === username) {
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
    displayName,
    ...servers,
    username,
    secret: seal(secret),
    folders,
    status: "ok" as const,
    statusError: null,
    consentedAt: new Date(),
  };
  const [saved] = await db
    .insert(mailbox)
    .values(values)
    .onConflictDoUpdate({ target: [mailbox.workspaceId, mailbox.userId], set: { ...values, syncedAt: null } })
    .returning();
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "mail.mailbox_connected",
    target: { type: "mailbox", id: saved.id, label: address },
  });
  return mailboxView(saved);
}

/** Disconnects the member's mailbox; the messages it brought stay on their rows. */
export async function disconnectMailbox(userId: string, workspaceId: string) {
  await requireMembership(userId, workspaceId);
  const [removed] = await db
    .delete(mailbox)
    .where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, userId)))
    .returning({ id: mailbox.id, address: mailbox.address });
  if (!removed) return;
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "mail.mailbox_disconnected",
    target: { type: "mailbox", id: removed.id, label: removed.address },
  });
}

/** Drops the mailboxes of people who left these workspaces (their passwords leave with them). */
export async function dropMailboxes(workspaceId: string, userIds: string[]) {
  if (!userIds.length) return;
  await db.delete(mailbox).where(and(eq(mailbox.workspaceId, workspaceId), inArray(mailbox.userId, userIds)));
}
