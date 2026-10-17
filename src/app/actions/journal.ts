"use server";

import { getLocale, getTranslations } from "next-intl/server";
import type { JournalStart } from "@/db/schema";
import { monthOf } from "@/lib/journal";
import * as journal from "@/server/journal";
import { requireUserId } from "@/server/session";
import { listTemplates } from "@/server/templates";

export type JournalResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(label: string, failure: "openFailed" | "saveFailed", fn: (userId: string) => Promise<T>): Promise<JournalResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    console.error(`[${label}]`, error);
    const t = await getTranslations("journal");
    return { ok: false, error: t(failure) };
  }
}

/**
 * Opens the user's note for `day`, made when they have none. The browser says which day it is
 * (its own time zone), so a note is never made for the server's idea of today.
 */
export async function openDailyNoteAction(workspaceId: string, day: string) {
  return run("open daily note", "openFailed", async (userId) => {
    const note = await journal.getOrCreateDailyNote({ userId }, String(workspaceId), String(day), { locale: await getLocale() });
    return { pageId: note.pageId, created: note.created };
  });
}

/** The days of the month `day` falls in that have a note, for the calendar. */
export async function dailyNoteDaysAction(workspaceId: string, day: string) {
  return run("list daily notes", "openFailed", async (userId) => {
    const { first, last } = monthOf(journal.checkDay(day));
    const notes = await journal.listDailyNotes(userId, String(workspaceId), { from: first, to: last });
    return notes.map((n) => ({ day: n.day, pageId: n.pageId }));
  });
}

export type JournalStartChoice = {
  start: JournalStart;
  templateId: string | null;
  /** The workspace's page templates the user can see, to pick from. */
  templates: { id: string; title: string; icon: string | null }[];
};

export async function journalSettingsAction(workspaceId: string) {
  return run("journal settings", "openFailed", async (userId): Promise<JournalStartChoice> => {
    const [settings, list] = await Promise.all([
      journal.getJournalSettings(userId, String(workspaceId)),
      listTemplates(userId, String(workspaceId)),
    ]);
    return {
      start: settings.start,
      templateId: settings.template?.id ?? null,
      templates: list.filter((t) => t.kind === "page").map(({ id, title, icon }) => ({ id, title, icon })),
    };
  });
}

export async function setJournalStartAction(workspaceId: string, start: JournalStart, templateId: string | null) {
  return run("journal settings", "saveFailed", async (userId) => {
    const settings = await journal.setJournalStart(userId, String(workspaceId), { start, templateId });
    return { start: settings.start, templateId: settings.template?.id ?? null };
  });
}
