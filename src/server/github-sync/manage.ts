import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { githubDelivery, githubSync, user } from "@/db/schema";
import { env } from "@/lib/env";
import { EMPTY_GITHUB_MAPPING, type GithubDeliveryView, type GithubMapping, type GithubSyncView } from "@/lib/github-sync";
import type { StatusGroup } from "@/lib/property-types";
import { uniqueIdPrefix } from "@/lib/unique-id";
import { recordAudit } from "@/server/audit";
import { addProperty, getProperties, requireDatabase } from "@/server/databases";
import { open, seal } from "@/server/secret-box";

/**
 * Setting up, changing and removing a database's GitHub setup (lib/github-sync; deliveries are
 * taken in ./receive). Only people with full access to the database see or change it, as with its
 * automations: whoever saves it last is who its writes are made as from then on. It needs a unique
 * ID property with a prefix, which is what pull requests name rows by.
 */

export class GithubSyncError extends Error {
  constructor(
    readonly code: "noUniqueId" | "invalidProperty" | "notSetUp",
    message: string,
  ) {
    super(message);
  }
}

/** Deliveries the dialog shows. */
const SHOWN_DELIVERIES = 20;

export const githubWebhookUrl = (syncId: string) => `${env.appUrl}/api/github/${syncId}`;
const newSecret = () => randomBytes(24).toString("base64url");

type Prop = Awaited<ReturnType<typeof getProperties>>[number];

/** A property the setup can choose, with a status property's options. */
export type GithubPropertyChoice = {
  id: string;
  name: string;
  type: "text" | "url" | "status";
  options: { id: string; name: string; color?: string; group?: StatusGroup }[];
};

/** What the setup dialog shows: the setup (null before there is one), the ID it matches, and the properties it can write. */
export type GithubSetupState = {
  sync: GithubSyncView | null;
  /** The database's unique ID property; null when it has none. Pull requests name rows by it once it has a prefix. */
  uniqueId: { name: string; prefix: string | null } | null;
  properties: GithubPropertyChoice[];
};

const uniqueIdOf = (props: Prop[]) => props.find((p) => p.type === "unique_id") ?? null;

function choices(props: Prop[]): GithubPropertyChoice[] {
  return props
    .filter((p) => p.type === "text" || p.type === "url" || p.type === "status")
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type as GithubPropertyChoice["type"],
      options: p.type === "status" ? (p.options.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color, group: o.group })) : [],
    }));
}

async function syncOf(databaseId: string) {
  const [row] = await db.select().from(githubSync).where(eq(githubSync.databaseId, databaseId));
  return row ?? null;
}

async function deliveriesOf(syncId: string): Promise<GithubDeliveryView[]> {
  const rows = await db
    .select()
    .from(githubDelivery)
    .where(eq(githubDelivery.syncId, syncId))
    .orderBy(desc(githubDelivery.receivedAt))
    .limit(SHOWN_DELIVERIES);
  return rows.map((r) => ({
    id: r.id,
    at: r.receivedAt.toISOString(),
    event: r.event,
    action: r.action,
    status: r.status,
    pullRequest: r.pullRequest,
    rows: r.rows,
    error: r.error,
  }));
}

async function view(row: typeof githubSync.$inferSelect): Promise<GithubSyncView> {
  const [runAs] = row.runAs ? await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, row.runAs)) : [];
  let secret: string | null = null;
  try {
    secret = open(row.secret);
  } catch {
    // Sealed with a key the server no longer has: a new secret replaces it.
  }
  return { webhookUrl: githubWebhookUrl(row.id), secret, mapping: row.mapping, runAs: runAs ?? null, deliveries: await deliveriesOf(row.id) };
}

/** The database's GitHub setup and what it can write. Needs full access to the database. */
export async function getGithubSetup(userId: string, databaseId: string): Promise<GithubSetupState> {
  await requireDatabase(userId, databaseId, "full");
  const props = await getProperties(databaseId);
  const uid = uniqueIdOf(props);
  const row = await syncOf(databaseId);
  return {
    sync: row ? await view(row) : null,
    uniqueId: uid ? { name: uid.name, prefix: uniqueIdPrefix(uid) } : null,
    properties: choices(props),
  };
}

export type GithubSetupInput = {
  /** The property links go to, by id; null for none. */
  linkPropertyId?: string | null;
  /** Makes a text property with this name for the links instead. */
  newLinkProperty?: string | null;
  statusPropertyId?: string | null;
  opened?: string | null;
  merged?: string | null;
  closed?: string | null;
};

const idOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The mapping as given, checked against the database's properties. */
function checkMapping(props: Prop[], input: GithubSetupInput): GithubMapping {
  const linkPropertyId = idOrNull(input.linkPropertyId);
  if (linkPropertyId) {
    const prop = props.find((p) => p.id === linkPropertyId);
    if (!prop || (prop.type !== "text" && prop.type !== "url")) throw new GithubSyncError("invalidProperty", "Links go to a text or url property");
  }
  const statusPropertyId = idOrNull(input.statusPropertyId);
  if (!statusPropertyId) return { ...EMPTY_GITHUB_MAPPING, linkPropertyId };
  const status = props.find((p) => p.id === statusPropertyId);
  if (!status || status.type !== "status") throw new GithubSyncError("invalidProperty", "Pull requests move rows in a status property");
  const options = status.options.options ?? [];
  const option = (value: unknown) => {
    const id = idOrNull(value);
    if (id && !options.some((o) => o.id === id)) throw new GithubSyncError("invalidProperty", "Not an option of the status property");
    return id;
  };
  return { linkPropertyId, statusPropertyId, opened: option(input.opened), merged: option(input.merged), closed: option(input.closed) };
}

const auditDetails = (mapping: GithubMapping, props: Prop[]) => {
  const name = (id: string | null) => (id ? (props.find((p) => p.id === id)?.name ?? null) : null);
  return { links: name(mapping.linkPropertyId), status: name(mapping.statusPropertyId) };
};

/**
 * Sets the database's GitHub setup up, or changes it: where links go and how statuses move. Whoever
 * saves it is who its writes are made as from then on. A new setup gets its own address and secret.
 */
export async function saveGithubSetup(userId: string, databaseId: string, input: GithubSetupInput): Promise<GithubSetupState> {
  const database = await requireDatabase(userId, databaseId, "full");
  let props = await getProperties(databaseId);
  const uid = uniqueIdOf(props);
  if (!uid || !uniqueIdPrefix(uid)) throw new GithubSyncError("noUniqueId", "Give the database a unique ID property with a prefix first");
  let given = input;
  const newName = typeof input.newLinkProperty === "string" ? input.newLinkProperty.trim().slice(0, 200) : "";
  if (newName) {
    const created = await addProperty(userId, databaseId, { name: newName, type: "text" });
    props = await getProperties(databaseId);
    given = { ...input, linkPropertyId: created.id };
  }
  const mapping = checkMapping(props, given);
  const current = await syncOf(databaseId);
  if (current) {
    await db.update(githubSync).set({ mapping, runAs: userId }).where(eq(githubSync.id, current.id));
    await recordAudit({
      workspaceId: database.workspaceId,
      actorId: userId,
      action: "github_sync.updated",
      target: { type: "page", id: databaseId },
      details: { ...auditDetails(mapping, props), previous: auditDetails(current.mapping, props) },
    });
  } else {
    await db.insert(githubSync).values({ workspaceId: database.workspaceId, databaseId, secret: seal(newSecret()), mapping, runAs: userId, createdBy: userId });
    await recordAudit({
      workspaceId: database.workspaceId,
      actorId: userId,
      action: "github_sync.created",
      target: { type: "page", id: databaseId },
      details: auditDetails(mapping, props),
    });
  }
  return getGithubSetup(userId, databaseId);
}

async function requireSetup(userId: string, databaseId: string) {
  const database = await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new GithubSyncError("notSetUp", "GitHub isn't set up for this database");
  return { database, row };
}

/** A new secret: deliveries signed with the old one are refused from now on. */
export async function rotateGithubSecret(userId: string, databaseId: string): Promise<GithubSetupState> {
  const { database, row } = await requireSetup(userId, databaseId);
  await db.update(githubSync).set({ secret: seal(newSecret()), runAs: userId }).where(eq(githubSync.id, row.id));
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "github_sync.updated",
    target: { type: "page", id: databaseId },
    details: { secretRotated: true },
  });
  return getGithubSetup(userId, databaseId);
}

/** Stops taking pull requests: the rows keep what was written; the address and secret are gone. */
export async function removeGithubSetup(userId: string, databaseId: string) {
  const { database, row } = await requireSetup(userId, databaseId);
  await db.delete(githubSync).where(eq(githubSync.id, row.id));
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "github_sync.deleted",
    target: { type: "page", id: databaseId },
    details: auditDetails(row.mapping, await getProperties(databaseId)),
  });
}
