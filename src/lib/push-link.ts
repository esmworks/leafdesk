/**
 * Where opening a notification leads, for push messages and the inbox alike. Its own module: the
 * reminder over the page (in every workspace page's first load) needs it, not the rest of push.ts.
 */

import { aiLimitPath } from "./agent-guardrails";
import { agentPagePath } from "./agent-page";
import { agentMemoryPath, agentReportPath, agentRunPath } from "./agents";
import { chatPath } from "./ai-chat";
import { commentHash } from "./comments";
import { rowEmailHash } from "./mail";
import { parseMassTrash } from "./mass-trash";
import { reviewPath } from "./pending-changes";
import type { PushItem } from "./push";

/** Where opening the notification leads: the same place the inbox does. */
export function pushLink(item: PushItem): string {
  if (item.kind === "agent_approval") {
    return item.approval ? agentRunPath(item.workspaceId, item.approval.agentId, item.approval.runId) : `/w/${item.workspaceId}/settings?tab=agents`;
  }
  if (item.kind === "agent_memory") return item.memory ? agentMemoryPath(item.workspaceId, item.memory.agentId) : `/w/${item.workspaceId}/settings?tab=agents`;
  if (item.kind === "agent_report") return item.report ? agentReportPath(item.workspaceId, item.report.agentId, item.report.runId) : `/w/${item.workspaceId}/settings?tab=agents`;
  // A task's report opens the chat with the agent that gave it, which the person works with (the
  // agent that did it may not be shared with them).
  if (item.kind === "agent_task") return item.report?.from ? agentPagePath(item.workspaceId, item.report.from.agentId) : `/w/${item.workspaceId}`;
  // A schedule turned off: the agent's page, where it is set again; one's own request, the AI chat its answers went to.
  if (item.kind === "schedule_paused") return item.schedulePaused?.agentId ? agentPagePath(item.workspaceId, item.schedulePaused.agentId) : `/w/${item.workspaceId}/ai`;
  // The AI chat waiting opens the conversation, where it asks; once it no longer waits, the chat.
  if (item.kind === "ai_chat_waiting") return chatPath(item.workspaceId, item.chatWaiting?.conversationId);
  if (item.kind === "review") return reviewPath(item.workspaceId);
  if (item.kind === "ai_limit") return aiLimitPath(item.workspaceId, item.aiLimit?.agent?.id ?? null);
  // The owner answers in the inbox; the agent is where its limit and use are.
  if (item.kind === "agent_limit_request") return aiLimitPath(item.workspaceId, item.limitRequest?.agentId ?? null);
  // The workspace's AI account is chosen in Settings > General.
  if (item.kind === "ai_account_detached") return `/w/${item.workspaceId}/settings`;
  // Findings are reviewed, and dismissed, in Settings > Security.
  if (item.kind === "sensitive_content") return `/w/${item.workspaceId}/settings?tab=security#setting-sensitiveFindings`;
  // Reports are dismissed, or the page taken off the web, in Settings > Security.
  if (item.kind === "page_reported") return `/w/${item.workspaceId}/settings?tab=security#setting-pageReports`;
  // Rows trashed in bulk: the database's history, where they come back in one step; a whole
  // database, its page in the trash, which brings it back.
  if (item.kind === "mass_trash" && item.pageId) {
    return `/w/${item.workspaceId}/p/${item.pageId}${parseMassTrash(item.automationMessage)?.what === "rows" ? "?history=1" : ""}`;
  }
  // A reminder opens the page it is about, else the chat with the agent that set it.
  if (item.kind === "ai_reminder" && item.pageId === null) return item.aiReminder?.agentId ? agentPagePath(item.workspaceId, item.aiReminder.agentId) : `/w/${item.workspaceId}`;
  if (item.pageId === null) return `/w/${item.workspaceId}/settings?tab=members&view=requests`;
  if (item.kind === "row_email" && item.rowEmail) return `/w/${item.workspaceId}/p/${item.pageId}${rowEmailHash(item.rowEmail.id)}`;
  return `/w/${item.workspaceId}/p/${item.pageId}${(item.kind === "comment" || item.kind === "reaction") && item.threadId ? commentHash(item.threadId) : ""}`;
}
