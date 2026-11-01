/**
 * Files read on the person's computer (server/agents/computer.ts) stay with them: once a chat run,
 * or an earlier turn of its conversation, listed a folder or read a file there, nothing the run
 * does may carry it out: no connection's tool (reads too: their addresses and arguments go out), no
 * web page or search, no other agent (ask_agent, assign_agent) and no email sent (send_email).
 * Pages of the workspace and the computer's own tools stay open. Server-only callers; kept apart
 * from lib/agents.ts, which client code loads.
 */
import { COMPUTER_READ_TOOLS, type AgentStepRecord } from "./agents";

/** Whether a run's steps show it brought something in from the person's computer. */
export const readLocalFiles = (steps: readonly (AgentStepRecord | { kind: string })[] | undefined): boolean =>
  (steps ?? []).some((s) => s.kind === "tool" && "tool" in s && s.connectionId === null && s.outcome === "done" && COMPUTER_READ_TOOLS.has(s.tool));

/**
 * Where a conversation first holds something from the person's computer: the first message whose
 * run read there, or a summary drawn from such turns (`localRead`); -1 when none does. Everything
 * from there on may quote it, however far back it was read.
 */
export function firstLocalRead(messages: readonly { steps?: readonly (AgentStepRecord | { kind: string })[]; localRead?: true }[]): number {
  return messages.findIndex((m) => m.localRead === true || readLocalFiles(m.steps));
}

/** What a run is told when a call would carry out what it read on the person's computer. */
export const AFTER_LOCAL_READ =
  "Files on the person's computer were read in this conversation, and they stay with the person: from here on nothing goes out of Leafdesk (no connected service's tool, web page or search, other agent or email). Nothing was done; say what you would do instead, and the person can do it.";
