"use server";

import { getFormatter, getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import {
  createMeetingNote,
  finishMeeting,
  isMeetingError,
  markMeetingGap,
  meetingHeartbeat,
  regenerateMeetingSummary,
  startMeeting,
  type ChunkPlace,
} from "@/server/meetings";
import { getSession } from "@/server/session";

// Meeting notes (server/meetings.ts): starting and ending a recording, the transcript's gaps and
// the summary. The recording's pieces go to /api/meetings/chunk. Refusals come back translated,
// with their code.

async function run<T>(fn: (user: { id: string; name: string }) => Promise<T>): Promise<ActionResult<T>> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  try {
    return { ok: true, data: await fn({ id: session.user.id, name: session.user.name }) };
  } catch (error) {
    const t = await getTranslations("meetings.errors");
    if (isMeetingError(error)) return { ok: false, error: t(error.code), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("noAccess"), code: "noAccess" };
    if (isAiError(error) && error.code === "rateLimited") return { ok: false, error: t("busy"), code: "rateLimited" };
    console.error("[meetings action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** Only the strings and numbers a place is made of, whatever the browser sent. */
const id = (value: unknown) => (typeof value === "string" ? value.slice(0, 100) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);
const placeOf = (place: ChunkPlace): ChunkPlace => ({
  pageId: id(place?.pageId),
  meetingId: id(place?.meetingId),
  chunk: num(place?.chunk),
  offset: num(place?.offset),
  duration: num(place?.duration),
});

export async function startMeetingAction(pageId: string, meetingId: string) {
  return run((user) => startMeeting(user.id, id(pageId), id(meetingId), user.name));
}

export async function markMeetingGapAction(place: ChunkPlace) {
  return run((user) => markMeetingGap(user.id, placeOf(place)));
}

export async function meetingHeartbeatAction(pageId: string, meetingId: string, seconds: number) {
  return run((user) => meetingHeartbeat(user.id, id(pageId), id(meetingId), num(seconds)));
}

export async function finishMeetingAction(pageId: string, meetingId: string, seconds?: number) {
  return run((user) => finishMeeting(user.id, id(pageId), id(meetingId), seconds === undefined ? undefined : num(seconds)));
}

export async function regenerateMeetingSummaryAction(pageId: string, meetingId: string) {
  return run((user) => regenerateMeetingSummary(user.id, id(pageId), id(meetingId)));
}

/** "New meeting note" on the Meetings page: a private page with a meeting block, titled for today. */
export async function createMeetingNoteAction(workspaceId: string) {
  return run(async (user) => {
    const t = await getTranslations("meetings");
    const format = await getFormatter();
    const title = t("newPageTitle", { date: format.dateTime(new Date(), { dateStyle: "medium" }) });
    return createMeetingNote(user.id, id(workspaceId), title);
  });
}
