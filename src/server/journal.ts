import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyNote, journal, page, type JournalStart } from "@/db/schema";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import templateTexts from "@/i18n/messages/en/templates.json";
import { dailyNoteTitle, dailyNotePosition, isDay } from "@/lib/journal";
import { AccessError, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { archivePage, createPage, deletePagePermanently } from "@/server/pages";
import { createFromTemplate } from "@/server/templates";

/**
 * Daily notes: one page per person, workspace and calendar day (the day in the person's own time
 * zone, which the caller works out). They go under the person's journal, a private page of theirs
 * made with their first note, so they stay out of everyone else's sidebar and search; the newest
 * day is listed first. A new note starts from a few headings in the person's language, blank, or
 * from a workspace template they picked (`setJournalStart`).
 *
 * A note in the trash no longer counts: opening its day makes a new one. Copies of a note are
 * ordinary pages; moving a note elsewhere keeps it that day's note.
 */

export class JournalError extends Error {
  constructor(
    message: string,
    readonly code: "badDay" | "notATemplate",
  ) {
    super(message);
    this.name = "JournalError";
  }
}

/** Days before or after these aren't taken: a typo (year 20266) rather than a note. */
const FIRST_DAY = "1900-01-01";
const LAST_DAY = "2999-12-31";

export function checkDay(day: unknown): string {
  if (!isDay(day) || day < FIRST_DAY || day > LAST_DAY) {
    throw new JournalError("A day is written YYYY-MM-DD, between 1900 and 2999", "badDay");
  }
  return day;
}

type JournalTexts = typeof templateTexts.journal;

/** The journal page's title and how a note starts by default, in `locale` (English for any other). */
async function journalTexts(locale: string | undefined): Promise<JournalTexts> {
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return templateTexts.journal;
  const translated = (await loadLocaleFile(locale, "templates")) as { journal?: unknown } | undefined;
  return withFallback(templateTexts.journal, translated?.journal);
}

export type JournalSettings = {
  /** The journal page, when there is one in place (not in the trash). */
  pageId: string | null;
  start: JournalStart;
  /** The template new notes copy, when `start` is "template" and the user can still see it. */
  template: { id: string; title: string; icon: string | null } | null;
};

export async function getJournalSettings(userId: string, workspaceId: string): Promise<JournalSettings> {
  await requireMembership(userId, workspaceId);
  const [row] = await db
    .select({ pageId: journal.pageId, start: journal.start, templateId: journal.templateId })
    .from(journal)
    .where(and(eq(journal.workspaceId, workspaceId), eq(journal.userId, userId)));
  if (!row) return { pageId: null, start: "default", template: null };
  const pageId = row.pageId && (await livePage(userId, row.pageId)) ? row.pageId : null;
  const template = row.start === "template" && row.templateId ? await visibleTemplate(userId, workspaceId, row.templateId) : null;
  return { pageId, start: row.start === "template" && !template ? "default" : row.start, template };
}

/** A page of the workspace's template picker (not a database) the user can see; null otherwise. */
async function visibleTemplate(userId: string, workspaceId: string, templateId: string) {
  const [row] = await db
    .select({ id: page.id, title: page.title, icon: page.icon })
    .from(page)
    .where(
      and(
        eq(page.id, templateId),
        eq(page.workspaceId, workspaceId),
        eq(page.isTemplate, true),
        isNull(page.parentId),
        eq(page.kind, "page"),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    );
  return row ?? null;
}

async function livePage(userId: string, pageId: string) {
  const [row] = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.id, pageId), isNull(page.archivedAt), pageVisibleTo(userId)));
  return Boolean(row);
}

/** Sets how the user's new daily notes start; "template" needs a page template they can see. */
export async function setJournalStart(
  userId: string,
  workspaceId: string,
  input: { start: JournalStart; templateId?: string | null },
): Promise<JournalSettings> {
  await requireMembership(userId, workspaceId);
  const start = input.start;
  if (start !== "default" && start !== "blank" && start !== "template") {
    throw new JournalError('Start new notes as "default", "blank" or "template"', "notATemplate");
  }
  let templateId: string | null = null;
  if (start === "template") {
    if (!input.templateId || !(await visibleTemplate(userId, workspaceId, input.templateId))) {
      throw new JournalError("Not a page template of this workspace", "notATemplate");
    }
    templateId = input.templateId;
  }
  await db
    .insert(journal)
    .values({ workspaceId, userId, start, templateId })
    .onConflictDoUpdate({ target: [journal.workspaceId, journal.userId], set: { start, templateId } });
  return getJournalSettings(userId, workspaceId);
}

export type DailyNoteSummary = { day: string; pageId: string; title: string; icon: string | null };

/** The user's daily notes from `from` to `to` (both included, either open), newest first. */
export async function listDailyNotes(
  userId: string,
  workspaceId: string,
  { from, to, limit = 400 }: { from?: string; to?: string; limit?: number } = {},
): Promise<DailyNoteSummary[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({ day: dailyNote.day, pageId: page.id, title: page.title, icon: page.icon })
    .from(dailyNote)
    .innerJoin(page, eq(page.id, dailyNote.pageId))
    .where(
      and(
        eq(dailyNote.workspaceId, workspaceId),
        eq(dailyNote.userId, userId),
        from ? gte(dailyNote.day, checkDay(from)) : undefined,
        to ? lte(dailyNote.day, checkDay(to)) : undefined,
        isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(sql`${dailyNote.day} desc`)
    .limit(Math.min(Math.max(1, limit), 1000));
  return rows;
}

/** The user's note for `day`, when there is one (out of the trash). */
export async function findDailyNote(userId: string, workspaceId: string, day: string): Promise<DailyNoteSummary | null> {
  const [found] = await listDailyNotes(userId, workspaceId, { from: day, to: day, limit: 1 });
  return found ?? null;
}

/**
 * The user's journal page in the workspace, made (private, at the top level) when they have none in
 * place. Guests who may not add top-level pages can't have one (AccessError).
 */
async function ensureJournalPage(actor: WriteActor, workspaceId: string, texts: JournalTexts): Promise<string> {
  const { userId } = actor;
  await db.insert(journal).values({ workspaceId, userId }).onConflictDoNothing();
  const [row] = await db
    .select({ pageId: journal.pageId })
    .from(journal)
    .where(and(eq(journal.workspaceId, workspaceId), eq(journal.userId, userId)));
  const current = row?.pageId ?? null;
  if (current && (await livePage(userId, current))) {
    // Still somewhere they may add pages: a journal moved under a page they can only read takes no notes.
    const editable = await requirePageAccess(userId, current, "edit").then(
      () => true,
      () => false,
    );
    if (editable) return current;
  }
  const created = await createPage(actor, { workspaceId, teamspaceId: null, title: texts.title, icon: "📔" });
  // Whoever replaced the old one first wins; a journal made at the same moment goes away unseen.
  const [won] = await db
    .update(journal)
    .set({ pageId: created.id })
    .where(
      and(
        eq(journal.workspaceId, workspaceId),
        eq(journal.userId, userId),
        current ? eq(journal.pageId, current) : isNull(journal.pageId),
      ),
    )
    .returning({ pageId: journal.pageId });
  if (won) return created.id;
  await discard(userId, created.id);
  return ensureJournalPage(actor, workspaceId, texts);
}

/** A page made for nothing (another request made the same one first), deleted for good. */
async function discard(userId: string, pageId: string) {
  await archivePage(userId, pageId)
    .then(() => deletePagePermanently(userId, pageId))
    .catch((error) => console.error("[journal] couldn't remove a duplicate page", error));
}

export type OpenedDailyNote = DailyNoteSummary & { created: boolean };

/**
 * The user's note for `day`, made when they have none: under their journal, titled with the day in
 * `locale` (English without one), started as their journal settings say.
 */
export async function getOrCreateDailyNote(
  actor: WriteActor,
  workspaceId: string,
  day: string,
  { locale }: { locale?: string } = {},
): Promise<OpenedDailyNote> {
  const { userId } = actor;
  checkDay(day);
  const existing = await findDailyNote(userId, workspaceId, day);
  if (existing) return { ...existing, created: false };

  const texts = await journalTexts(locale);
  const settings = await getJournalSettings(userId, workspaceId);
  const parentId = await ensureJournalPage(actor, workspaceId, texts);
  const title = dailyNoteTitle(day, isLocale(locale) ? locale : DEFAULT_LOCALE);
  const pageId =
    settings.start === "template" && settings.template
      ? (await createFromTemplate(actor, settings.template.id, { parentId, title })).id
      : (await createPage(actor, { workspaceId, parentId, title, markdown: settings.start === "blank" ? undefined : texts.markdown })).id;
  await db.update(page).set({ position: dailyNotePosition(day) }).where(eq(page.id, pageId));

  // A note for this day made meanwhile (another tab, an assistant) wins; this one goes away unseen.
  // One in the trash is replaced.
  const [won] = await db
    .insert(dailyNote)
    .values({ workspaceId, userId, day, pageId })
    .onConflictDoUpdate({
      target: [dailyNote.workspaceId, dailyNote.userId, dailyNote.day],
      set: { pageId, createdAt: new Date() },
      where: sql`not exists (select 1 from ${page} p where p.id = ${dailyNote.pageId} and p.archived_at is null)`,
    })
    .returning({ pageId: dailyNote.pageId });
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  if (!won) {
    await discard(userId, pageId);
    const winner = await findDailyNote(userId, workspaceId, day);
    if (!winner) throw new AccessError();
    return { ...winner, created: false };
  }
  const [row] = await db.select({ title: page.title, icon: page.icon }).from(page).where(eq(page.id, pageId));
  return { day, pageId, title: row?.title ?? title, icon: row?.icon ?? null, created: true };
}

/** The day a page is the user's note for, if it is one. */
export async function dailyNoteDay(userId: string, pageId: string): Promise<string | null> {
  const [row] = await db
    .select({ day: dailyNote.day })
    .from(dailyNote)
    .where(and(eq(dailyNote.pageId, pageId), eq(dailyNote.userId, userId)));
  return row?.day ?? null;
}
