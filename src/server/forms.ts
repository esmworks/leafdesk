import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseView, file, formPublication, page, user, type FormConfig, type NumberFormat, type SelectOption } from "@/db/schema";
import { asFiles, fileIdOf, fileUrl, type FileValue } from "@/lib/files";
import { env } from "@/lib/env";
import {
  checkAnswers,
  formDefaults,
  formQuestions,
  isBlankAnswer,
  MAX_SUBMISSION_BYTES,
  type AnswerError,
  type ResolvedQuestion,
  writableProperties,
} from "@/lib/forms";
import { normalizeValue, PropertyValueError, sortStatusOptions } from "@/lib/properties";
import { holdsOptions } from "@/lib/property-types";
import { unknownToVisitors } from "@/lib/published-copy";
import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import { AccessError, accessRank, hasLevel, pageAccessOf, requireMembership, requirePageAccess, type RequiredLevel } from "@/server/access";
import { getProperties, insertRows, normalizeRowProperties, withCode, type DatabaseProperty } from "@/server/databases";
import { propertyAccessFor } from "@/server/property-access";
import { publishBlocker } from "@/server/publication";
import { storeFile, type StoredFile, type UploadInput } from "@/server/files";
import { canPublish, publishingOn, workspacePeople } from "@/server/workspaces";

/**
 * Form views: people fill in a form and each answer becomes a row of the database.
 *
 * In the app, anyone who may add rows to the database (edit access) can fill in its forms; the
 * row is theirs, as if they had added it themselves. Viewers see the form but can't send it.
 *
 * A form can also be opened to the web (`/f/<token>`), like publishing a page: that needs full
 * access to the database and the workspace's publishing policy, and owners see every public form
 * in Settings > Security, where they can close any of them. A public form asks only questions
 * whose answers show nothing of the workspace (no relations or people, see isPublicAskable) and
 * reveals nothing but its questions and their options. It takes answers only while its publisher
 * can still add rows to the database and the database isn't in the trash. Without `anonymous`
 * people must sign in (any account, not only members) and their rows record them as creator;
 * with it nobody is recorded, not even people who happen to be signed in.
 *
 * Public answers are rate limited per IP address and per form, must arrive a moment after the
 * form was loaded (a signed ticket), and carry a honeypot field that people never see.
 *
 * Property access: a form writes with someone's standing, and asks (and sets defaults for) only
 * the properties that person may set in a new row (see answerable). In the app that is the person
 * answering: questions about properties they may not change are left out, not refused, and ones
 * they can't know of never reach them (getDatabase drops them from the view). A public form writes
 * with its publisher's standing: its answerers never see the database, and the publisher chose
 * its questions, labels and property names included, to be shown to anyone with the link.
 */

/**
 * The properties a form may write when it writes with `userId`'s standing: those whose values they
 * may set in a new row created by `createdBy` (see lib/forms writableProperties).
 */
async function answerable(userId: string, databaseId: string, properties: DatabaseProperty[], createdBy: string | null) {
  return writableProperties(await propertyAccessFor(userId, databaseId), properties, createdBy);
}

export type FormErrorCode =
  | "notAForm"
  | "invalidAnswers"
  | "closed"
  | "signInRequired"
  | "rateLimited"
  | "tooFast"
  | "expired"
  | "tooLarge"
  | "notAllowed"
  | "publishingOff"
  | "inTrash";

export class FormError extends Error {
  constructor(
    message: string,
    readonly code: FormErrorCode,
    /** For `invalidAnswers`: what is wrong with which question. */
    readonly answers: AnswerError[] = [],
  ) {
    super(message);
    this.name = "FormError";
  }
}

/** Site path of a public form; the client prefixes its own origin for copying. */
export const publicFormPath = (token: string) => `/f/${token}`;

/** The form view and its database, for someone with at least `needed` access to the database. */
async function requireForm(userId: string, viewId: string, needed: RequiredLevel) {
  const [view] = await db.select().from(databaseView).where(eq(databaseView.id, viewId)).limit(1);
  if (!view) throw new AccessError();
  const database = await requirePageAccess(userId, view.databaseId, needed);
  if (view.type !== "form") throw new FormError("This view is not a form", "notAForm");
  return { view, database };
}

function assertSize(answers: unknown) {
  let size: number;
  try {
    size = JSON.stringify(answers ?? {}).length;
  } catch {
    size = Infinity;
  }
  if (size > MAX_SUBMISSION_BYTES || !answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new FormError("The answers are too long", "tooLarge");
  }
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The form's default values that still hold: options that still exist, people still in the
 * workspace, rows of the related database that aren't in the trash. A default that went stale is
 * dropped rather than refusing every answer until someone fixes the form.
 */
async function liveDefaults(database: { workspaceId: string }, properties: DatabaseProperty[], form: FormConfig | undefined) {
  const out: Record<string, unknown> = {};
  let people: Set<string> | undefined;
  for (const [id, value] of Object.entries(formDefaults(form, properties))) {
    const prop = properties.find((p) => p.id === id)!;
    let next: unknown;
    try {
      next = normalizeValue(prop, value);
    } catch (error) {
      if (error instanceof PropertyValueError) continue;
      throw error;
    }
    if (prop.type === "person") {
      people ??= new Set((await workspacePeople(database.workspaceId)).map((p) => p.id));
      next = asIds(next).filter((userId) => people!.has(userId));
    } else if (prop.type === "relation") {
      const ids = asIds(next);
      const targetId = prop.options.relation?.databaseId;
      const live =
        targetId && ids.length
          ? await db
              .select({ id: page.id })
              .from(page)
              .where(and(eq(page.parentId, targetId), inArray(page.id, ids), eq(page.isTemplate, false), isNull(page.archivedAt)))
          : [];
      next = ids.filter((rowId) => live.some((r) => r.id === rowId));
    }
    if (!isBlankAnswer(next)) out[id] = next;
  }
  return out;
}

function invalidAnswers(errors: AnswerError[]) {
  return new FormError("Some answers are missing or invalid", "invalidAnswers", errors);
}

// ---------------------------------------------------------------------------------------------
// Files in answers
//
// A form's files question takes uploads before the answer is sent: each goes to the form's
// database (uploadFormFile, uploadPublicFormFile), which holds it, unused, until the answer creates
// its row. The answer then names the uploads (their paths), claimFormFiles checks they are uploads
// to this database that no row uses yet, and the new row takes them over (adoptFormFiles), so they
// belong to it exactly as if they had been uploaded to the row. Uploads nobody sends go away with
// the other unused uploads after a day (files.purgeUnusedUploads).

/** Answers to files questions, apart from the others (which are checked as row values). */
function splitFileAnswers(properties: DatabaseProperty[], values: Record<string, unknown>) {
  const files: Record<string, FileValue[]> = {};
  const rest: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    if (properties.some((p) => p.id === id && p.type === "files")) files[id] = asFiles(value);
    else rest[id] = value;
  }
  return { files, rest };
}

/**
 * The files answers as stored values (the files' own names and types), when every file is an
 * unused upload to this form's database; refuses the answer otherwise, naming the question.
 */
async function claimFormFiles(
  database: { id: string; workspaceId: string },
  properties: DatabaseProperty[],
  answers: Record<string, FileValue[]>,
): Promise<Record<string, FileValue[]>> {
  const ids = Object.values(answers).flatMap((list) => list.flatMap((f) => fileIdOf(f.url) ?? []));
  const pending = new Map(
    (ids.length
      ? await db
          .select({ id: file.id, name: file.name, contentType: file.contentType })
          .from(file)
          .where(
            and(
              inArray(file.id, ids),
              eq(file.pageId, database.id),
              eq(file.workspaceId, database.workspaceId),
              isNull(file.referencedAt),
            ),
          )
      : []
    ).map((f) => [f.id, f]),
  );
  const errors: AnswerError[] = [];
  const out: Record<string, FileValue[]> = {};
  for (const [propertyId, list] of Object.entries(answers)) {
    const values = list.flatMap((f) => {
      const stored = pending.get(fileIdOf(f.url) ?? "");
      return stored ? [{ url: fileUrl(stored.id), name: stored.name, type: stored.contentType }] : [];
    });
    if (values.length !== list.length) {
      const prop = properties.find((p) => p.id === propertyId);
      errors.push({ propertyId, code: "invalidFile", params: { property: prop?.name ?? "" } });
    } else if (values.length) out[propertyId] = values;
  }
  if (errors.length) throw invalidAnswers(errors);
  return out;
}

/** The new row takes over the uploads its answer holds (they were the database's until now). */
async function adoptFormFiles(databaseId: string, rowId: string, claimed: Record<string, FileValue[]>) {
  const ids = Object.values(claimed).flatMap((list) => list.flatMap((f) => fileIdOf(f.url) ?? []));
  if (!ids.length) return;
  await db
    .update(file)
    .set({ pageId: rowId })
    .where(and(inArray(file.id, ids), eq(file.pageId, databaseId)));
}

/** Whether the form asks a files question (publicly, with `public`), so it takes uploads. */
function asksForFiles(form: FormConfig | undefined, properties: DatabaseProperty[], options: { public?: boolean } = {}) {
  return formQuestions(form, properties, options).some((q) => q.prop?.type === "files");
}

/**
 * Stores a file for an answer to a form in the app, held by the form's database until the answer
 * is sent. Needs what sending the answer needs: edit access to the database.
 */
export async function uploadFormFile(userId: string, viewId: string, input: UploadInput): Promise<StoredFile> {
  const { view, database } = await requireForm(userId, viewId, "edit");
  if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  if (!asksForFiles(view.config.form, await answerable(userId, database.id, await getProperties(database.id), userId))) {
    throw new FormError("This form doesn't ask for files", "notAllowed");
  }
  return storeFile({ workspaceId: database.workspaceId, pageId: database.id, uploadedBy: userId }, input);
}

/** Uploads to public forms per IP address, and per form from everyone together. */
export const FORM_FILE_RATE_LIMITS = {
  perIp: { limit: 30, windowMs: 10 * 60_000 },
  perForm: { limit: 300, windowMs: 60 * 60_000 },
};
const fileIpLimiter = new SlidingWindowLimiter(FORM_FILE_RATE_LIMITS.perIp.limit, FORM_FILE_RATE_LIMITS.perIp.windowMs);
const fileFormLimiter = new SlidingWindowLimiter(FORM_FILE_RATE_LIMITS.perForm.limit, FORM_FILE_RATE_LIMITS.perForm.windowMs);

/**
 * Stores a file for an answer to a public form, held by the form's database until the answer is
 * sent (see above). Like answering: the link must be open, the form must be loaded (its ticket),
 * sign-in is needed unless the form is anonymous, and uploads are rate limited per IP address and
 * per form. The uploader can't read the file back (they can't see the database); the form shows
 * what they picked from their own device.
 */
export async function uploadPublicFormFile(
  token: string,
  { userId, ip, ticket, now = Date.now() }: { userId: string | null; ip: string; ticket: unknown; now?: number },
  input: UploadInput,
): Promise<StoredFile> {
  const form = await openPublicForm(token);
  if (!form) throw new FormError("This form is closed", "closed");
  if (!form.anonymous && !userId) throw new FormError("Sign in to fill in this form", "signInRequired");
  const age = ticketAge(token, ticket, now);
  if (age === null || age > MAX_TICKET_AGE_MS) throw new FormError("The form has expired; reload it", "expired");
  const publishedBy = form.publishedBy!;
  if (!asksForFiles(form.config.form, await answerable(publishedBy, form.databaseId, await getProperties(form.databaseId), null), { public: true })) {
    throw new FormError("This form doesn't ask for files", "notAllowed");
  }
  if (takeAll([[fileIpLimiter, ip], [fileFormLimiter, form.viewId]], now) > 0) {
    throw new FormError("Too many uploads; try again later", "rateLimited");
  }
  return storeFile(
    { workspaceId: form.workspaceId, pageId: form.databaseId, uploadedBy: form.anonymous ? null : userId },
    input,
  );
}

/**
 * Fills in a form in the app: adds a row with the answers and the form's default values, created
 * by the user. Needs edit access to the database, like adding a row any other way.
 */
export async function submitForm(userId: string, viewId: string, answers: Record<string, unknown>) {
  assertSize(answers);
  const { view, database } = await requireForm(userId, viewId, "edit");
  if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  // Only what they may set in the row they add (see answerable).
  const properties = await answerable(userId, database.id, await getProperties(database.id), userId);
  const checked = checkAnswers(formQuestions(view.config.form, properties), answers);
  if (!checked.ok) throw invalidAnswers(checked.errors);
  const { files, rest } = splitFileAnswers(properties, checked.properties);
  // Linked rows and people are looked up as the person answering: only what they can see.
  const values = await normalizeRowProperties(userId, database.id, rest, {}, { createdBy: userId });
  const claimed = await claimFormFiles(database, properties, files);
  const defaults = await liveDefaults(database, properties, view.config.form);
  const [row] = await insertRows(database, userId, [{ title: checked.title, properties: { ...defaults, ...values, ...claimed } }]);
  await adoptFormFiles(database.id, row.id, claimed);
  return { id: row.id };
}

// ---------------------------------------------------------------------------------------------
// Opening a form to the web

export type FormSharing = {
  /**
   * `live` is false when whoever opened the link can no longer add rows to the database: the link
   * then takes no answers until someone opens it again (see publishForm).
   */
  publication: { token: string; url: string; anonymous: boolean; createdAt: Date; live: boolean } | null;
  /** Why the user can't open the form to the web, or null when they can. */
  blocker: Awaited<ReturnType<typeof publishBlocker>>;
};

/** The form's public link, if any, for anyone who can see the database. */
export async function getFormSharing(userId: string, viewId: string): Promise<FormSharing> {
  const { database } = await requireForm(userId, viewId, "view");
  const [[row], blocker] = await Promise.all([
    db
      .select({
        token: formPublication.token,
        anonymous: formPublication.anonymous,
        createdAt: formPublication.createdAt,
        publishedBy: formPublication.publishedBy,
      })
      .from(formPublication)
      .where(eq(formPublication.viewId, viewId))
      .limit(1),
    publishBlocker(userId, database.id),
  ]);
  if (!row) return { publication: null, blocker };
  const { publishedBy, ...publication } = row;
  const live = await publisherCanAdd(publishedBy, database.id);
  return { publication: { ...publication, url: publicFormPath(row.token), live }, blocker };
}

/** Whether a form's publisher can still add rows to its database, which keeps its link taking answers. */
async function publisherCanAdd(publishedBy: string | null, databaseId: string) {
  if (!publishedBy) return false;
  // The publisher's standing, whoever is looking (their own session may be held back by a policy).
  const { level } = await pageAccessOf(publishedBy, databaseId);
  return hasLevel(level, "edit");
}

/**
 * Public links of these form views, by view id. No access check: for callers that already checked
 * the user can see the views' database (MCP's get_database).
 */
export async function formPublicationsOf(viewIds: string[]) {
  const rows = viewIds.length
    ? await db
        .select({ viewId: formPublication.viewId, token: formPublication.token, anonymous: formPublication.anonymous })
        .from(formPublication)
        .where(inArray(formPublication.viewId, viewIds))
    : [];
  return new Map(rows.map((r) => [r.viewId, { url: publicFormPath(r.token), anonymous: r.anonymous }]));
}

async function assertMayPublish(userId: string, database: { workspaceId: string; archivedAt: Date | null }) {
  if (!(await publishingOn(database.workspaceId))) {
    throw new FormError("Publishing to the web is turned off in this workspace", "publishingOff");
  }
  if (!(await canPublish(userId, database.workspaceId))) {
    throw new FormError("This workspace lets only owners publish to the web", "notAllowed");
  }
  if (database.archivedAt) throw new FormError("Forms of databases in the trash can't be published", "inTrash");
}

/**
 * Opens a form to the web, or changes whether it takes anonymous answers. Needs full access to the
 * database and the workspace's publishing policy. An open form keeps its link, and the user becomes
 * its publisher: a link whose earlier publisher lost access takes answers again.
 */
export async function publishForm(userId: string, viewId: string, { anonymous = false }: { anonymous?: boolean } = {}) {
  const { database } = await requireForm(userId, viewId, "full");
  await assertMayPublish(userId, database);
  const [row] = await db
    .insert(formPublication)
    .values({ viewId, token: randomBytes(32).toString("base64url"), anonymous, publishedBy: userId })
    .onConflictDoUpdate({ target: formPublication.viewId, set: { anonymous, publishedBy: userId } })
    .returning({ token: formPublication.token, anonymous: formPublication.anonymous, createdAt: formPublication.createdAt });
  return { ...row, url: publicFormPath(row.token) };
}

/** Closes a form's public link; opening it again makes a new one. Needs full access to the database. */
export async function unpublishForm(userId: string, viewId: string) {
  await requireForm(userId, viewId, "full");
  await db.delete(formPublication).where(eq(formPublication.viewId, viewId));
}

export type WorkspaceFormPublication = {
  viewId: string;
  databaseId: string;
  /** View and database names; null when the owner can't see the database (they may close it, not read it). */
  viewName: string | null;
  title: string | null;
  icon: string | null;
  /** Site path, for forms the owner can see that still take answers. */
  url: string | null;
  inTrash: boolean;
  /** False when whoever opened the link can no longer add rows: it takes no answers. */
  live: boolean;
  anonymous: boolean;
  publishedBy: string | null;
  createdAt: Date;
};

/** Every public form of the workspace, newest first, for owners to review. */
export async function listWorkspaceFormPublications(userId: string, workspaceId: string): Promise<WorkspaceFormPublication[]> {
  await requireMembership(userId, workspaceId, "owner");
  const served = await publishingOn(workspaceId);
  const rows = await db
    .select({
      viewId: databaseView.id,
      viewName: databaseView.name,
      databaseId: page.id,
      title: page.title,
      icon: page.icon,
      archivedAt: page.archivedAt,
      token: formPublication.token,
      anonymous: formPublication.anonymous,
      publishedBy: user.name,
      publisherId: formPublication.publishedBy,
      createdAt: formPublication.createdAt,
      visible: sql<boolean>`${accessRank(userId, sql`${page.id}`)} > 0`,
    })
    .from(formPublication)
    .innerJoin(databaseView, eq(databaseView.id, formPublication.viewId))
    .innerJoin(page, eq(page.id, databaseView.databaseId))
    .leftJoin(user, eq(user.id, formPublication.publishedBy))
    .where(eq(page.workspaceId, workspaceId))
    .orderBy(desc(formPublication.createdAt));
  const live = await Promise.all(rows.map((r) => publisherCanAdd(r.publisherId, r.databaseId)));
  return rows.map((r, i) => ({
    viewId: r.viewId,
    databaseId: r.databaseId,
    viewName: r.visible ? r.viewName : null,
    title: r.visible ? r.title : null,
    icon: r.visible ? r.icon : null,
    url: r.visible && !r.archivedAt && live[i] && served ? publicFormPath(r.token) : null,
    inTrash: r.archivedAt !== null,
    live: live[i],
    anonymous: r.anonymous,
    publishedBy: r.publishedBy,
    createdAt: r.createdAt,
  }));
}

/** Closes a public form of the workspace, whoever opened it. Owners only. */
export async function revokeFormPublication(userId: string, workspaceId: string, viewId: string) {
  await requireMembership(userId, workspaceId, "owner");
  const inWorkspace = db
    .select({ id: databaseView.id })
    .from(databaseView)
    .innerJoin(page, eq(page.id, databaseView.databaseId))
    .where(and(eq(databaseView.id, viewId), eq(page.workspaceId, workspaceId)));
  await db.delete(formPublication).where(and(eq(formPublication.viewId, viewId), inArray(formPublication.viewId, inWorkspace)));
}

// ---------------------------------------------------------------------------------------------
// Public forms (no workspace access needed). Everything below trusts only the token.

/** The one property a public question shows: its options, never its relation or anything else. */
export type PublicFormProperty = Pick<DatabaseProperty, "id" | "name" | "type"> & { options: { options?: SelectOption[]; number?: NumberFormat } };
export type PublicForm = {
  token: string;
  title: string;
  description: string;
  questions: ResolvedQuestion<PublicFormProperty>[];
  /** Whether it takes answers without signing in (and records nobody). */
  anonymous: boolean;
  confirmation: string;
  allowAnother: boolean;
};

/**
 * The live public form for `token`: open, its database not in the trash, its publisher still able
 * to add rows, and its workspace with publishing on (off keeps the link for when it is back on).
 */
async function openPublicForm(token: string) {
  if (!token || token.length > 128) return null;
  const [found] = await db
    .select({
      viewId: databaseView.id,
      type: databaseView.type,
      config: databaseView.config,
      databaseId: page.id,
      workspaceId: page.workspaceId,
      title: page.title,
      anonymous: formPublication.anonymous,
      publishedBy: formPublication.publishedBy,
    })
    .from(formPublication)
    .innerJoin(databaseView, eq(databaseView.id, formPublication.viewId))
    .innerJoin(page, eq(page.id, databaseView.databaseId))
    .where(and(eq(formPublication.token, token), isNull(page.archivedAt), eq(page.kind, "database")))
    .limit(1);
  if (!found || found.type !== "form" || !(await publishingOn(found.workspaceId))) return null;
  return (await publisherCanAdd(found.publishedBy, found.databaseId)) ? found : null;
}

function publicProperty(prop: DatabaseProperty, name = prop.name): PublicFormProperty {
  const options = holdsOptions(prop.type)
    ? (prop.type === "status" ? sortStatusOptions(prop.options.options ?? []) : (prop.options.options ?? [])).map(
        ({ id, name, color, group }) => ({ id, name, color, ...(group ? { group } : {}) }),
      )
    : undefined;
  // A number's format says how answers are read (a percentage in percent points).
  const number = prop.type === "number" ? prop.options.number : undefined;
  return { id: prop.id, name, type: prop.type, options: options ? { options } : number ? { number } : {} };
}

/** A public form as its page shows it, or null when the link doesn't (or no longer) work. */
export async function getPublicForm(token: string): Promise<PublicForm | null> {
  const found = await openPublicForm(token);
  if (!found) return null;
  const form = found.config.form;
  const all = await getProperties(found.databaseId);
  const [properties, visitors] = await Promise.all([
    answerable(found.publishedBy!, found.databaseId, all, null),
    propertyAccessFor(null, found.databaseId),
  ]);
  // A property visitors can't know of shows only as its question: labelled, its own name stays
  // behind; unlabelled, its name is what the publisher chose to ask.
  const unknown = unknownToVisitors(visitors, all);
  return {
    token,
    title: form?.title?.trim() || found.title,
    description: form?.description?.trim() ?? "",
    questions: formQuestions(form, properties, { public: true }).map((q) => ({
      ...q,
      prop: q.prop && publicProperty(q.prop, unknown.has(q.prop.id) && q.label ? q.label : q.prop.name),
    })),
    anonymous: found.anonymous,
    confirmation: form?.confirmation?.trim() ?? "",
    allowAnother: form?.allowAnother !== false,
  };
}

/** Public answers per IP address, and per form from everyone together. */
export const FORM_RATE_LIMITS = {
  perIp: { limit: 20, windowMs: 10 * 60_000 },
  perForm: { limit: 300, windowMs: 60 * 60_000 },
};
const ipLimiter = new SlidingWindowLimiter(FORM_RATE_LIMITS.perIp.limit, FORM_RATE_LIMITS.perIp.windowMs);
const formLimiter = new SlidingWindowLimiter(FORM_RATE_LIMITS.perForm.limit, FORM_RATE_LIMITS.perForm.windowMs);

/** Scripts and tests: start counting again. */
export function resetFormRateLimits() {
  ipLimiter.reset();
  formLimiter.reset();
  fileIpLimiter.reset();
  fileFormLimiter.reset();
}

/** People take at least this long to fill in a form; scripts that post right away don't. */
export const MIN_FILL_MS = 2000;
/** A form page left open longer has to be reloaded. */
const MAX_TICKET_AGE_MS = 24 * 60 * 60_000;

function signTicket(token: string, issuedAt: string) {
  return createHmac("sha256", env.authSecret).update(`form-ticket:${token}:${issuedAt}`).digest("base64url");
}

/** Proof of when the form page was loaded, sent back with the answers. */
export function issueFormTicket(token: string, now = Date.now()) {
  const issuedAt = String(now);
  return `${issuedAt}.${signTicket(token, issuedAt)}`;
}

/** How long ago the ticket was issued for this form, or null when it is forged or for another form. */
function ticketAge(token: string, ticket: unknown, now: number): number | null {
  if (typeof ticket !== "string" || ticket.length > 200) return null;
  const [issuedAt, signature] = ticket.split(".");
  if (!issuedAt || !signature || !/^\d{1,16}$/.test(issuedAt)) return null;
  const expected = Buffer.from(signTicket(token, issuedAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return now - Number(issuedAt);
}

export type PublicSubmission = {
  answers: Record<string, unknown>;
  /** From issueFormTicket, rendered into the page. */
  ticket: string;
  /** The hidden field; people leave it empty. */
  honeypot?: string;
};

/**
 * Answers a public form: checks the link, sign-in, spam guards and answers, then adds the row.
 * `userId` is who is signed in, if anyone; anonymous forms ignore it. Returns the new row's id,
 * or null when the answer was quietly dropped as spam.
 */
export async function submitPublicForm(
  token: string,
  submission: PublicSubmission,
  { userId, ip, now = Date.now() }: { userId: string | null; ip: string; now?: number },
): Promise<{ id: string | null }> {
  assertSize(submission.answers);
  const form = await openPublicForm(token);
  if (!form) throw new FormError("This form is closed", "closed");
  if (!form.anonymous && !userId) throw new FormError("Sign in to fill in this form", "signInRequired");

  const age = ticketAge(token, submission.ticket, now);
  if (age === null || age > MAX_TICKET_AGE_MS) throw new FormError("The form has expired; reload it", "expired");
  if (age < MIN_FILL_MS) throw new FormError("The form was sent too quickly", "tooFast");
  if (takeAll([[ipLimiter, ip], [formLimiter, form.viewId]], now) > 0) {
    throw new FormError("Too many answers; try again later", "rateLimited");
  }
  // Bots fill in every field. They are told it worked, so they have nothing to adapt to.
  if (typeof submission.honeypot === "string" && submission.honeypot.trim()) return { id: null };

  const properties = await answerable(form.publishedBy!, form.databaseId, await getProperties(form.databaseId), null);
  const checked = checkAnswers(formQuestions(form.config.form, properties, { public: true }), submission.answers);
  if (!checked.ok) throw invalidAnswers(checked.errors);
  // Public questions hold no links or people (isPublicAskable), so the checked values are final,
  // but for files, which must be this form's uploads.
  const database = { id: form.databaseId, workspaceId: form.workspaceId };
  const { files, rest } = splitFileAnswers(properties, checked.properties);
  const claimed = await claimFormFiles(database, properties, files);
  const defaults = await liveDefaults(database, properties, form.config.form);
  const creator = form.anonymous ? null : userId;
  const [row] = await insertRows(database, creator, [{ title: checked.title, properties: { ...defaults, ...rest, ...claimed } }]);
  await adoptFormFiles(database.id, row.id, claimed);
  return { id: row.id };
}
