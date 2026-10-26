/**
 * Opens the search box (components/sidebar/search-dialog, kept by the sidebar) with a query typed
 * in, from anywhere in the workspace: a `#tag` clicked in a page (components/page/tags.ts).
 */
export const OPEN_SEARCH_EVENT = "leafdesk:open-search";

export function openSearch(query: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_SEARCH_EVENT, { detail: query }));
}
