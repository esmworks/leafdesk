/**
 * Reminders the AI sets (inbox kind "ai_reminder"). A run someone stands behind (their chat
 * message, their request, the schedule they set, their comment that mentioned the agent) may
 * remind that person, and only them, of something at a time, about a page both they and the agent
 * can open. The AI chat reminds the person asking (server/ai-chat.ts): its reminder's actor is that
 * person. The tool takes no recipient, so nothing the run reads can point it at someone else.
 *
 * A reminder is a notification waiting snoozed until its time (`snoozedUntil`): deliverSnoozed
 * brings it into the inbox and pushes it then, and the person's open tabs show it over the page
 * (components/sidebar/reminder-prompt.tsx). No email goes out about it.
 */
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { notification } from "@/db/schema";
import {
  CHANGE_REMINDER_TOOL_NAME,
  LIST_REMINDERS_TOOL_NAME,
  MAX_REMINDER_AHEAD_MS,
  MAX_REMINDER_CHARS,
  MAX_REMINDERS_PER_RUN,
  MAX_WAITING_REMINDERS,
  REMIND_TOOL_NAME,
  reminderText,
  reminderTime,
} from "@/lib/ai-reminders";
import type { AgentRunSource, AgentStepRecord, AgentToolRecord } from "@/lib/agents";
import { clockText, dayString, localDay, wallClock } from "@/lib/time-zone";
import { hasLevel, pageAccessOf } from "@/server/access";
import type { AiTool, AiToolCall } from "@/server/ai";
import { nowLine } from "@/server/ai/prompts";
import { cancelReminder, listNotifications, moveReminder } from "@/server/notifications";

export { CHANGE_REMINDER_TOOL_NAME, LIST_REMINDERS_TOOL_NAME, REMIND_TOOL_NAME };

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
    case "channel":
      return source.mentionedBy;
    default:
      return null;
  }
}

/** Reminders a run has set already, counted from its steps, so a run resumed after an approval keeps its count. */
export function remindersSet(steps: readonly AgentStepRecord[]): number {
  return steps.filter((s) => s.kind === "tool" && s.tool === REMIND_TOOL_NAME && s.outcome === "done").length;
}

/**
 * The tool, telling the model the time where the person is (its run has no other clock); `chat`:
 * offered by the AI chat, to the person asking.
 */
export function remindTool(now: Date, timeZone: string, chat = false): AiTool {
  const example = `${dayString(localDay(now.getTime() + 86_400_000, timeZone))}T09:00`;
  return {
    name: REMIND_TOOL_NAME,
    description:
      `Sets a reminder for ${chat ? "the person asking" : "the person this run works for"} (no one else can be reminded): at the time given, it opens over the page they have open, ` +
      (chat
        ? `comes to their inbox and to their phone. Use it when they ask to be reminded of something once, at a time; not to tell them what you did (your answer does that). `
        : `comes to their inbox and to their phone. Use it when they ask to be reminded of something, or when your task says to remind them; not to tell them what you did (your answer does that). `) +
      `${nowLine(now, timeZone)} Give the time on their clock, as "${example}" for tomorrow at 9:00 there. ` +
      `At most ${MAX_REMINDER_AHEAD_MS / 86_400_000} days ahead, ${MAX_REMINDERS_PER_RUN} reminders per ${chat ? "answer" : "run"}. ` +
      `Until it comes, the person sees it, and may move or cancel it, under Scheduled in their inbox.`,
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

export const TIME_ERRORS = {
  format: 'Give "at" as a date and time on their clock, such as 2026-11-02T09:00.',
  past: "That time has passed. Give a time from now on.",
  tooFar: `A reminder can be set at most ${MAX_REMINDER_AHEAD_MS / 86_400_000} days ahead.`,
} as const;

/**
 * Sets the reminder a call asks for, for `personId` from `actorId` (the agent's user, or the person
 * themselves in the AI chat). Refused with a reason the model can act on when the text, time or
 * page doesn't do, or the actor has MAX_WAITING_REMINDERS waiting for that person already.
 */
export async function setReminder(
  input: { workspaceId: string; actorId: string; personId: string; timeZone: string },
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
    const [theirs, agents] = await Promise.all([pageAccessOf(input.personId, args.page_id), pageAccessOf(input.actorId, args.page_id)]);
    // Neither learns of a page the other can't open: the reminder would show its title.
    if (!theirs.page || theirs.page.workspaceId !== input.workspaceId || !hasLevel(theirs.level, "view") || !hasLevel(agents.level, "view")) {
      return { content: "That page isn't one both you and they can open. Leave out page_id, or give another.", isError: true };
    }
    pageId = args.page_id;
  }

  // Counted and added under one lock per agent and person, so runs at once can't pass the limit together.
  const full = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_reminder:${input.actorId}:${input.personId}`}))`);
    const [{ waiting }] = await tx
      .select({ waiting: count() })
      .from(notification)
      .where(
        and(
          eq(notification.userId, input.personId),
          eq(notification.workspaceId, input.workspaceId),
          eq(notification.kind, "ai_reminder"),
          eq(notification.actorId, input.actorId),
          gt(notification.snoozedUntil, now),
        ),
      );
    if (waiting >= MAX_WAITING_REMINDERS) return true;
    await tx.insert(notification).values({
      userId: input.personId,
      workspaceId: input.workspaceId,
      kind: "ai_reminder",
      actorId: input.actorId,
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
  const local = reminderWhen(time.at, input.timeZone);
  return {
    content: `Reminder set for ${local} (${input.timeZone}). It waits under Scheduled in their inbox, where they may move or cancel it.`,
    step: { kind: "tool", connectionId: null, tool: REMIND_TOOL_NAME, input: `${local} · ${text}`.slice(0, 400), outcome: "done" },
  };
}

/** "2026-11-02 09:00" on `timeZone`'s clock. */
export function reminderWhen(at: Date, timeZone: string) {
  const { day, minutes } = wallClock(at.getTime(), timeZone);
  return `${dayString(day)} ${clockText(minutes)}`;
}

/**
 * The tool listing the person's reminders still to come; `chat`: offered by the AI chat, listing
 * all of the person's (an agent's run lists only those its agent set).
 */
export function listRemindersTool(chat = false): AiTool {
  return {
    name: LIST_REMINDERS_TOOL_NAME,
    description:
      (chat
        ? "Lists the reminders still to come for the person asking, soonest first: what each says, when on their clock, the page it is about and who set it (they, in this chat or another, or an agent). "
        : "Lists the reminders you set for the person this run works for that are still to come, soonest first: what each says, when on their clock and the page it is about. ") +
      `Use it when they ask what reminders they have, or before ${CHANGE_REMINDER_TOOL_NAME}, which takes an id from this list. Notifications they snoozed aren't listed: they see those under Scheduled in their inbox.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
}

/** The tool cancelling or moving one of the reminders list_reminders lists; `chat` as for listRemindersTool. */
export function changeReminderTool(now: Date, timeZone: string, chat = false): AiTool {
  const example = `${dayString(localDay(now.getTime() + 86_400_000, timeZone))}T09:00`;
  return {
    name: CHANGE_REMINDER_TOOL_NAME,
    description:
      `Cancels one of ${chat ? "the person's reminders" : "the reminders you set for the person"} that hasn't come yet, or moves it to another time. ` +
      `Take its id from ${LIST_REMINDERS_TOOL_NAME} first; never guess one. Use it only when they ask to cancel, drop or move a reminder. ` +
      `${nowLine(now, timeZone)} For "move", give the new time on their clock, as "${example}" for tomorrow at 9:00 there, at most ${MAX_REMINDER_AHEAD_MS / 86_400_000} days ahead.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["cancel", "move"], description: '"cancel": it never comes. "move": it comes at "at" instead.' },
        reminder_id: { type: "string", description: `The reminder's id, from ${LIST_REMINDERS_TOOL_NAME}.` },
        at: { type: "string", description: `For "move": when, on their clock in ${timeZone}: "YYYY-MM-DDTHH:MM".` },
      },
      required: ["action", "reminder_id"],
      additionalProperties: false,
    },
  };
}

/** One of the person's reminders still to come, as the tools tell of it. */
export type PendingReminder = {
  id: string;
  at: Date;
  text: string;
  pageId: string | null;
  pageTitle: string | null;
  /** Who set it: the person themselves (their AI chat), an agent by name, or an agent since removed (null). */
  by: { own: true } | { own: false; agentName: string | null };
};

/**
 * Whose reminders to read: `personId`'s in the workspace, all of them (the AI chat) or only those
 * `actorId` set (an agent's run, whose user also must still open a reminder's page for its title
 * to be told).
 */
type ReminderScope = { workspaceId: string; personId: string; timeZone: string; actorId?: string };

/** The most reminders list_reminders reads: every agent's MAX_WAITING_REMINDERS for a few agents, and the person's own. */
const MAX_LISTED = 200;

/** The person's reminders still to come in the scope, soonest first. */
export async function pendingReminders(scope: ReminderScope): Promise<PendingReminder[]> {
  // Reminders alone, as the Scheduled tab lists them: snoozed notifications would take their room under the inbox's limit.
  const items = (await listNotifications(scope.personId, { workspaceId: scope.workspaceId, pending: true, kinds: ["ai_reminder"], limit: MAX_LISTED }).catch(() => [])).filter(
    (n) => n.snoozedUntil && (!scope.actorId || n.actorId === scope.actorId),
  );
  // An agent learns no title of a page it can no longer open (the person still may).
  const hidden = new Set<string>();
  if (scope.actorId) {
    const pageIds = [...new Set(items.flatMap((n) => (n.pageId ? [n.pageId] : [])))];
    const access = await Promise.all(pageIds.map((id) => pageAccessOf(scope.actorId!, id)));
    pageIds.forEach((id, i) => {
      if (!hasLevel(access[i].level, "view")) hidden.add(id);
    });
  }
  return items.map((n) => {
    const shown = n.pageId && !hidden.has(n.pageId) ? n.pageId : null;
    return {
      id: n.id,
      at: n.snoozedUntil!,
      text: n.aiReminder?.text ?? "",
      pageId: shown,
      pageTitle: shown ? (n.pageTitle ?? "") : null,
      by: n.aiReminder?.own ? { own: true } : { own: false, agentName: n.aiReminder?.agentName ?? null },
    };
  });
}

/**
 * What list_reminders answers: each reminder on the person's clock, with its id for
 * change_reminder. `others`: one was set by someone other than the person (an agent), whose
 * words the AI chat then has read (lib/agents.ts readOthersWords).
 */
export async function listReminders(scope: ReminderScope): Promise<{ content: string; count: number; others: boolean }> {
  const list = await pendingReminders(scope);
  const zone = `on their clock in ${scope.timeZone}`;
  if (!list.length) {
    return {
      content: scope.actorId ? "You have no reminders waiting for them." : "They have no reminders still to come in this workspace.",
      count: 0,
      others: false,
    };
  }
  const lines = list.map((r) => {
    const parts = [`id ${r.id}`, reminderWhen(r.at, scope.timeZone), JSON.stringify(r.text)];
    if (r.pageId) parts.push(`about the page ${JSON.stringify(r.pageTitle || "Untitled")} (page_id ${r.pageId})`);
    if (!scope.actorId) parts.push(r.by.own ? "set by them" : r.by.agentName ? `set by the agent ${JSON.stringify(r.by.agentName)}` : "set by an agent since removed");
    return `- ${parts.join(" · ")}`;
  });
  return {
    content: `${list.length} reminder${list.length === 1 ? "" : "s"} still to come, soonest first (times ${zone}):\n${lines.join("\n")}`,
    count: list.length,
    others: list.some((r) => !r.by.own),
  };
}

/**
 * What a change_reminder call asks for, checked against the person's reminders in the scope
 * before anyone is asked: the reminder as it is and, for a move, its new time. Refused with a
 * reason the model can act on otherwise.
 */
export async function prepareReminderChange(
  scope: ReminderScope,
  call: AiToolCall,
  now = new Date(),
): Promise<{ action: "cancel" | "move"; reminder: PendingReminder; at: Date | null; when: string; was: string } | Outcome> {
  const { action, reminder_id: id } = call.arguments;
  if (action !== "cancel" && action !== "move") return { content: 'Give "action": "cancel" or "move".', isError: true };
  if (typeof id !== "string" || !id) return { content: `Give "reminder_id", from ${LIST_REMINDERS_TOOL_NAME}.`, isError: true };
  const reminder = (await pendingReminders(scope)).find((r) => r.id === id);
  if (!reminder) {
    return { content: `There is no reminder still to come with that id${scope.actorId ? " that you set" : ""}: it may have come already. Call ${LIST_REMINDERS_TOOL_NAME} for the ids.`, isError: true };
  }
  const was = reminderWhen(reminder.at, scope.timeZone);
  if (action === "cancel") return { action, reminder, at: null, when: was, was };
  const time = reminderTime(call.arguments.at, now, scope.timeZone);
  if ("error" in time) return { content: TIME_ERRORS[time.error], isError: true };
  return { action, reminder, at: time.at, when: reminderWhen(time.at, scope.timeZone), was };
}

/** Cancels or moves the reminder prepareReminderChange found, held to the same scope. */
export async function applyReminderChange(scope: ReminderScope, change: { action: "cancel" | "move"; reminder: PendingReminder; at: Date | null; when: string }): Promise<Outcome> {
  const hold = { workspaceId: scope.workspaceId, actorId: scope.actorId };
  const done =
    change.action === "cancel" ? await cancelReminder(scope.personId, change.reminder.id, hold) : await moveReminder(scope.personId, change.reminder.id, change.at!, hold);
  if (!done) return { content: "That reminder came meanwhile, or is gone: nothing was changed.", isError: true };
  return {
    content:
      change.action === "cancel"
        ? `Cancelled: ${JSON.stringify(change.reminder.text)} won't come.`
        : `Moved: ${JSON.stringify(change.reminder.text)} now comes at ${change.when} (${scope.timeZone}).`,
    step: { kind: "tool", connectionId: null, tool: CHANGE_REMINDER_TOOL_NAME, input: `${change.action} ${change.when} · ${change.reminder.text}`.slice(0, 400), outcome: "done" },
  };
}
