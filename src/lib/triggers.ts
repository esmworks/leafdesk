/**
 * The trigger layer's shapes (server/triggers.ts): whose run a trigger starts, which conversation
 * it goes to, and the one list of what can start an agent's (or a person's own) runs. Pure, with
 * no server imports, so the agent's settings page can import the types.
 */

import type { RunSource } from "./agents";
import type { RepeatRule, ScheduleError } from "./schedule";

/** Whose run a trigger starts: an agent's (as the agent), or the person's own AI chat (as them, no agent). */
export type TriggerTarget = { agentId: string } | { self: string };

/**
 * Which conversation a triggered run goes to: a fresh one each time (`new`), the one kept for a key
 * (`keyed`: the same row, email thread, comment thread or schedule each time), or one already
 * given (`fixed`: a chat's own conversation, which the person writes in).
 */
export type ConversationRule = { rule: "new" } | { rule: "keyed"; key: string } | { rule: "fixed"; conversationId: string };

export type ConversationRuleKind = ConversationRule["rule"];

/** The longest key a conversation keeps (ids joined with a word, so far less in practice). */
export const MAX_CONVERSATION_KEY = 200;

/**
 * The conversation a run of this source goes to when its trigger names none: a row's runs (an
 * automation's, a row's request) keep the row's, a schedule's its own, a mention's its comment
 * thread's (in a channel, its message thread's), new email its thread's; a chat's, an own question's, its conversation; an event's,
 * a request on no row and another agent's task each start a fresh one.
 */
export function conversationRuleFor(source: RunSource): ConversationRule {
  switch (source.kind) {
    case "automation":
      return { rule: "keyed", key: `row:${source.rowId}` };
    case "request":
      return source.rowId ? { rule: "keyed", key: `row:${source.rowId}` } : { rule: "new" };
    case "schedule":
      return { rule: "keyed", key: `schedule:${source.scheduleId}` };
    case "mention":
    case "channel":
      return { rule: "keyed", key: `thread:${source.threadId}` };
    case "mail":
      return { rule: "keyed", key: `mail:${source.threadId}` };
    case "chat":
      return { rule: "fixed", conversationId: source.conversationId };
    case "assistant":
      return source.scheduleId ? { rule: "keyed", key: `schedule:${source.scheduleId}` } : { rule: "fixed", conversationId: source.conversationId };
    case "connection":
    case "handoff":
      return { rule: "new" };
  }
}

/** A trigger's kind in the list (TriggerView). */
export const TRIGGER_KINDS = ["chat", "mention", "channel", "request", "schedule", "automation", "button", "mail", "connection"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Where a trigger can start runs only by being used (chat, a mention in a comment or a channel, request): whether the viewer may now. */
export type TriggerAvailability = { available: boolean };

/**
 * One thing that can start the agent's (or, for `self`, the person's own) runs, as the viewer may
 * see it (server/triggers.ts listTriggers). `conversation` is the rule its runs follow.
 */
export type TriggerView = { conversation: ConversationRuleKind } & (
  | ({ kind: "chat" | "mention" | "channel" | "request" } & TriggerAvailability)
  | {
      kind: "schedule";
      id: string;
      /** "agent": one of the agent's schedules; "own_request": a question the person asks on a schedule. */
      scheduleKind: "agent" | "own_request";
      enabled: boolean;
      rule: RepeatRule;
      timeZone: string;
      /** Empty when `taskHidden`: it may name what is in a database the viewer can't open. */
      task: string;
      taskHidden: boolean;
      databaseId: string | null;
      nextRunAt: string | null;
      lastRunAt: string | null;
      lastError: ScheduleError | null;
      /** Runs that failed in a row (lib/schedule SCHEDULE_FAILURE_LIMIT turns it off). */
      failures: number;
      setBy: { id: string; name: string } | null;
    }
  | {
      /** An automation whose steps run the agent; `button` when a button property's click starts it. */
      kind: "automation" | "button";
      id: string;
      name: string;
      enabled: boolean;
      databaseId: string;
      databaseTitle: string;
      /** The automation's trigger (lib/automations AutomationTrigger `type`). */
      trigger: string;
      /** A button's property. */
      propertyId: string | null;
    }
  | {
      /** New email in one of the viewer's own mailboxes opened to the agent. */
      kind: "mail";
      mailboxId: string;
      address: string;
      enabled: boolean;
      task: string;
    }
  | {
      /** An event a connection of the workspace receives (owners only). */
      kind: "connection";
      id: string;
      connectionId: string;
      connectionName: string;
      eventType: string | null;
      enabled: boolean;
      trusted: boolean;
      prompt: string;
    }
);
