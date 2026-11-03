import { agentChatInfoAction, agentChatTurnAction, agentThreadAction, agentThreadRunsAction, getAgentConversationAction, searchAgentChatsAction } from "@/app/actions/agent-chat";
import { dueTasksAction, taskCountsAction } from "@/app/actions/assigned";
import { agentCreationAction, agentMailboxesAction, pendingAgentLimitRequestAction, sidebarAgentsAction } from "@/app/actions/agents";
import { getConversationAction, listConversationsAction } from "@/app/actions/ai";
import { listDatabasesAction, loadDatabaseAction, loadRowAction } from "@/app/actions/databases";
import { getThreadAction, listMailboxesAction, listThreadsAction, openDraftAction, openMailboxAction, prefetchBodiesAction, readBodyAction, refreshFolderAction, sendStatusAction, suggestAddressesAction } from "@/app/actions/mail";
import { sidebarMeetingsAction } from "@/app/actions/meetings";
import { backlinksAction, unlinkedMentionsAction } from "@/app/actions/mentions";
import { arrivalsAction, dueRemindersAction, listInboxAction, unreadCountAction } from "@/app/actions/notifications";
import { recordPageViewAction } from "@/app/actions/page-views";
import { placeAtAction } from "@/app/actions/places";
import { getPageReviewAction, listTrashAction, recentSearchAction, searchAction, searchFilterOptionsAction } from "@/app/actions/pages";
import { relatedPagesAction } from "@/app/actions/related-pages";
import { pendingCountAction, runProposalsAction } from "@/app/actions/review";
import { discoverMailServersAction } from "@/app/actions/row-mail";
import { settingsSearchAction } from "@/app/actions/settings-search";
import { usableSnippetsAction } from "@/app/actions/snippets";
import { tagSuggestionsAction } from "@/app/actions/tags";
import { listTriggersAction } from "@/app/actions/triggers";

/**
 * Server actions that components call on their own (as a page opens, on a timer, as a box fills)
 * and that only read, served by `/api/read/<name>` so they run side by side: Next runs a tab's
 * server actions one at a time, so these held up what the person clicked behind them. Each is
 * called as it is, with the person's session; components call them through `components/read.ts`.
 * Their results go as JSON with dates (lib/read-wire.ts).
 */
export const READS = {
  backlinks: backlinksAction,
  unlinkedMentions: unlinkedMentionsAction,
  relatedPages: relatedPagesAction,
  pageReview: getPageReviewAction,
  usableSnippets: usableSnippetsAction,
  recordPageView: recordPageViewAction,
  unreadCount: unreadCountAction,
  dueReminders: dueRemindersAction,
  arrivals: arrivalsAction,
  pendingCount: pendingCountAction,
  dueTasks: dueTasksAction,
  taskCounts: taskCountsAction,
  runProposals: runProposalsAction,
  sidebarAgents: sidebarAgentsAction,
  sidebarMeetings: sidebarMeetingsAction,
  agentCreation: agentCreationAction,
  agentLimitRequest: pendingAgentLimitRequestAction,
  agentMailboxes: agentMailboxesAction,
  agentTriggers: listTriggersAction,
  recentSearch: recentSearchAction,
  searchFilterOptions: searchFilterOptionsAction,
  search: searchAction,
  tagSuggestions: tagSuggestionsAction,
  settingsSearch: settingsSearchAction,
  trash: listTrashAction,
  inbox: listInboxAction,
  loadDatabase: loadDatabaseAction,
  loadRow: loadRowAction,
  listDatabases: listDatabasesAction,
  agentChatInfo: agentChatInfoAction,
  agentThread: agentThreadAction,
  agentThreadRuns: agentThreadRunsAction,
  agentConversation: getAgentConversationAction,
  agentChatTurn: agentChatTurnAction,
  agentChatSearch: searchAgentChatsAction,
  chatConversations: listConversationsAction,
  chatConversation: getConversationAction,
  placeAt: placeAtAction,
  mailboxes: listMailboxesAction,
  mailOpen: openMailboxAction,
  mailRefreshFolder: refreshFolderAction,
  mailThreads: listThreadsAction,
  mailThread: getThreadAction,
  mailBody: readBodyAction,
  mailAhead: prefetchBodiesAction,
  mailDiscover: discoverMailServersAction,
  mailAddresses: suggestAddressesAction,
  mailDraft: openDraftAction,
  mailSend: sendStatusAction,
};

export type Reads = typeof READS;
