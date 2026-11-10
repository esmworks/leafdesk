import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceAgent } from "@/db/schema";
import { agentReportPath, readEmail, type AgentRunCode, type AgentRunSource, type AgentStepRecord } from "@/lib/agents";
import { env } from "@/lib/env";
import { markdownLead } from "@/lib/markdown-plain";
import { redactError } from "@/lib/redact";
import { escapeHtml, markdownToTelegramBlocks } from "@/lib/telegram-format";
import { findMembership, pageAccessOf, workspacesHiddenFromApp } from "@/server/access";
import { runAsConnectedApp } from "@/server/connected-app";
import { linksToAgent } from "./links";
import { html, localeOf, packFor, sendHtml, translatorFor, type Chat, type Translator } from "./say";
import { anyChatApp, transportOf } from "./transports";

/**
 * A routine's summary in chat apps: when a schedule's run ends (other than quietly, finish_run
 * `nothing_new`), the person who set the schedule hears of it in each chat with the bot they linked,
 * when that chat is pointed at this agent of the run's workspace (/agent, agent-chat.ts): the agent's name,
 * the task it finished (or couldn't), the start of its report (SUMMARY_CHARS, cut between
 * paragraphs) or why it failed (`agent.routine.reasons`, one for each run code; the agent's own
 * reason when it ended itself as failed), and a link to the run on the agent's page. It is the person's own
 * chat with the agent, so it says what the report says, unlike a notification (lib/push.ts); the
 * inbox's `agent_report` goes as well. Checked as the bot checks a connected app's call: a
 * workspace that turned connected apps off, one the person left, or a database they can no longer
 * open sends nothing; a run that read their email sends neither summary nor reason (they show only
 * in the app).
 * Never throws: the run's ending is saved either way.
 */

/** The most of a report the message carries; the run has all of it. */
const SUMMARY_CHARS = 500;
/** The most of the task the message names. */
const TASK_CHARS = 100;

export type EndedRoutine = {
  id: string;
  workspaceId: string;
  agentId: string;
  source: Extract<AgentRunSource, { kind: "schedule" }>;
  status: "done" | "failed";
  code: AgentRunCode | null;
  /** As saved: masked, and for a run ended with finish_run, its reason. */
  answer: string;
  steps: AgentStepRecord[];
  /** The schedule's task. */
  prompt: string;
};

export async function tellRoutineEnded(run: EndedRoutine): Promise<void> {
  if (!anyChatApp()) return;
  const userId = run.source.scheduledBy;
  try {
    const chats = (await linksToAgent(userId, run.workspaceId, run.agentId)).flatMap((link): Chat[] => {
      const transport = transportOf(link.channel);
      return transport ? [{ transport, id: link.chatId }] : [];
    });
    if (!chats.length) return;
    const reachable = await runAsConnectedApp({ userId }, async () => {
      if (!(await findMembership(userId, run.workspaceId)) || (await workspacesHiddenFromApp(userId)).has(run.workspaceId)) return false;
      // What it found may quote the database: only for someone who can still open it.
      return !run.source.databaseId || (await pageAccessOf(userId, run.source.databaseId)).level !== "none";
    });
    if (!reachable) return;
    const [agent] = await db.select({ name: workspaceAgent.name }).from(workspaceAgent).where(eq(workspaceAgent.id, run.agentId));
    if (!agent) return;
    const locale = await localeOf(userId);
    for (const chat of chats) await say(chat, translatorFor(locale, chat.transport.channel), agent.name);
  } catch (error) {
    console.error("[chat-apps] couldn't send a routine's summary", redactError(error));
  }

  async function say(chat: Chat, t: Translator, agentName: string) {
    const line = run.prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
    const task = line.length > TASK_CHARS ? `${line.slice(0, TASK_CHARS - 1).trimEnd()}…` : line;
    const head = html(t, run.status === "failed" ? "agent.routine.failed" : "agent.routine.done", { agent: `<b>${escapeHtml(agentName)}</b>`, task: escapeHtml(task) });
    const body = readEmail(run.steps)
      ? [`<i>${escapeHtml(t("agent.routine.email"))}</i>`]
      : run.status === "failed"
        ? [`<i>${escapeHtml(run.code === "selfReported" && run.answer.trim() ? run.answer.trim() : t(`agent.routine.reasons.${run.code ?? "error"}`))}</i>`]
        : markdownToTelegramBlocks(markdownLead(run.answer, SUMMARY_CHARS));
    const open = `<a href="${escapeHtml(`${env.appUrl}${agentReportPath(run.workspaceId, run.agentId, run.id)}`)}">${escapeHtml(t("notify.openRun"))}</a>`;
    await sendHtml(chat, packFor(chat, [head, ...body, open]));
  }
}
