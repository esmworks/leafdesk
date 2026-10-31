/**
 * Reminders agents set (inbox kind "ai_reminder"). A run someone stands behind (their chat
 * message, their request, the schedule they set, their comment that mentioned the agent) may
 * remind that person, and only them, of something at a time, about a page both they and the agent
 * can open. The tool takes no recipient, so nothing the run reads can point it at someone else.
 *
 * A reminder is a notification waiting snoozed until its time (`snoozedUntil`): deliverSnoozed
 * brings it into the inbox and pushes it then, and the person's open tabs show it over the page
 * (components/sidebar/reminder-prompt.tsx). No email goes out about it.
 */
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { notification } from "@/db/schema";
import { MAX_REMINDER_AHEAD_MS, MAX_REMINDER_CHARS, MAX_REMINDERS_PER_RUN, MAX_WAITING_REMINDERS, reminderText, reminderTime } from "@/lib/ai-reminders";
import type { AgentRunSource, AgentStepRecord, AgentToolRecord } from "@/lib/agents";
import { clockText, dayString, localDay, wallClock } from "@/lib/time-zone";
import { hasLevel, pageAccessOf } from "@/server/access";
import type { AiTool, AiToolCall } from "@/server/ai";
import { nowLine } from "@/server/ai/prompts";

export const REMIND_TOOL_NAME = "remind_person";

/** Who a run may remind: whoever wrote to the agent, asked for the run, set its schedule or mentioned it. Nobody on other runs. */
export function remindedPerson(source: AgentRunSource): string | null {
  switch (source.kind) {
    case "chat":
      return source.userId;
    case "request":
      return source.requestedBy;
    case "schedule":
      return source.scheduledBy;
    case "mention":
      return source.mentionedBy;
    default:
      return null;
  }
}

/** Reminders a run has set already, counted from its steps, so a run resumed after an approval keeps its count. */
export function remindersSet(steps: readonly AgentStepRecord[]): number {
  return steps.filter((s) => s.kind === "tool" && s.tool === REMIND_TOOL_NAME && s.outcome === "done").length;
}

/** The tool, telling the model the time where the person is (its run has no other clock). */
export function remindTool(now: Date, timeZone: string): AiTool {
  const example = `${dayString(localDay(now.getTime() + 86_400_000, timeZone))}T09:00`;
  return {
    name: REMIND_TOOL_NAME,
    description:
      `Sets a reminder for the person this run works for (no one else can be reminded): at the time given, it opens over the page they have open, ` +
      `comes to their inbox and to their phone. Use it when they ask to be reminded of something, or when your task says to remind them; not to tell them what you did (your answer does that). ` +
      `${nowLine(now, timeZone)} Give the time on their clock, as "${example}" for tomorrow at 9:00 there. ` +
      `At most ${MAX_REMINDER_AHEAD_MS / 86_400_000} days ahead, ${MAX_REMINDERS_PER_RUN} reminders per run.`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: `What to remind them of, at most ${MAX_REMINDER_CHARS} characters, in their language, as a note to them ("Call Ayşe about the offer").` },
        at: { type: "string", description: `When, on their clock in ${timeZone}: "YYYY-MM-DDTHH:MM".` },
        page_id: { type: "string", description: "A page or row the reminder is about, which opens from it. Optional." },
      },
      required: ["text", "at"],
      additionalProperties: false,
    },
  };
}

type Outcome = { content: string; isError?: boolean; step?: AgentToolRecord };

const TIME_ERRORS = {
  format: 'Give "at" as a date and time on their clock, such as 2026-11-02T09:00.',
  past: "That time has passed. Give a time from now on.",
  tooFar: `A reminder can be set at most ${MAX_REMINDER_AHEAD_MS / 86_400_000} days ahead.`,
} as const;

/**
 * Sets the reminder a run's call asks for, for `personId` from the agent's user `agentUserId`.
 * Refused with a reason the model can act on when the text, time or page doesn't do, or the agent
 * has MAX_WAITING_REMINDERS waiting for that person already.
 */
export async function setReminder(
  input: { workspaceId: string; agentUserId: string; personId: string; timeZone: string },
  call: AiToolCall,
  now = new Date(),
): Promise<Outcome> {
  const args = call.arguments;
  const text = reminderText(args.text);
  if (!text) return { content: 'Give "text": what to remind them of.', isError: true };
  const time = reminderTime(args.at, now, input.timeZone);
  if ("error" in time) return { content: TIME_ERRORS[time.error], isError: true };

  let pageId: string | null = null;
  if (args.page_id !== undefined && args.page_id !== null && args.page_id !== "") {
    if (typeof args.page_id !== "string") return { content: '"page_id" is the id of a page.', isError: true };
    const [theirs, agents] = await Promise.all([pageAccessOf(input.personId, args.page_id), pageAccessOf(input.agentUserId, args.page_id)]);
    // Neither learns of a page the other can't open: the reminder would show its title.
    if (!theirs.page || theirs.page.workspaceId !== input.workspaceId || !hasLevel(theirs.level, "view") || !hasLevel(agents.level, "view")) {
      return { content: "That page isn't one both you and they can open. Leave out page_id, or give another.", isError: true };
    }
    pageId = args.page_id;
  }

  // Counted and added under one lock per agent and person, so runs at once can't pass the limit together.
  const full = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_reminder:${input.agentUserId}:${input.personId}`}))`);
    const [{ waiting }] = await tx
      .select({ waiting: count() })
      .from(notification)
      .where(
        and(
          eq(notification.userId, input.personId),
          eq(notification.workspaceId, input.workspaceId),
          eq(notification.kind, "ai_reminder"),
          eq(notification.actorId, input.agentUserId),
          gt(notification.snoozedUntil, now),
        ),
      );
    if (waiting >= MAX_WAITING_REMINDERS) return true;
    await tx.insert(notification).values({
      userId: input.personId,
      workspaceId: input.workspaceId,
      kind: "ai_reminder",
      actorId: input.agentUserId,
      pageId,
      message: text,
      // Woken by the snooze sweep (deliverSnoozed) at its time, within half a minute.
      snoozedUntil: time.at,
    });
    return false;
  });
  if (full) {
    return { content: `You have ${MAX_WAITING_REMINDERS} reminders waiting for them already, the most at once. Set this one once some have come.`, isError: true };
  }
  const local = localTime(time.at, input.timeZone);
  return {
    content: `Reminder set for ${local} (${input.timeZone}).`,
    step: { kind: "tool", connectionId: null, tool: REMIND_TOOL_NAME, input: `${local} · ${text}`.slice(0, 400), outcome: "done" },
  };
}

/** "2026-11-02 09:00" on `timeZone`'s clock. */
function localTime(at: Date, timeZone: string) {
  const { day, minutes } = wallClock(at.getTime(), timeZone);
  return `${dayString(day)} ${clockText(minutes)}`;
}
