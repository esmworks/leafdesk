import { sidebarAgentsAction } from "@/app/actions/agents";
import { loadDatabaseAction } from "@/app/actions/databases";
import { backlinksAction, unlinkedMentionsAction } from "@/app/actions/mentions";
import { unreadCountAction } from "@/app/actions/notifications";
import { recordPageViewAction } from "@/app/actions/page-views";
import { getPageReviewAction, listTrashAction, recentSearchAction, searchAction, searchFilterOptionsAction } from "@/app/actions/pages";
import { relatedPagesAction } from "@/app/actions/related-pages";
import { pendingCountAction } from "@/app/actions/review";
import { settingsSearchAction } from "@/app/actions/settings-search";
import { usableSnippetsAction } from "@/app/actions/snippets";
import { tagSuggestionsAction } from "@/app/actions/tags";

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
  pendingCount: pendingCountAction,
  sidebarAgents: sidebarAgentsAction,
  recentSearch: recentSearchAction,
  searchFilterOptions: searchFilterOptionsAction,
  search: searchAction,
  tagSuggestions: tagSuggestionsAction,
  settingsSearch: settingsSearchAction,
  trash: listTrashAction,
  loadDatabase: loadDatabaseAction,
};

export type Reads = typeof READS;
