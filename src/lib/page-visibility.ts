/**
 * Whether a property shows on its database's row pages: always (the default), only when the row
 * has a value for it, or never. Set per property for everyone (PropertyOptions `pageVisibility`);
 * the properties a row page leaves out are a click away under "N more properties". Pure and
 * client-safe.
 */

export const PAGE_VISIBILITIES = ["show", "hide_empty", "hide"] as const;
export type PageVisibility = (typeof PAGE_VISIBILITIES)[number];

export function isPageVisibility(value: unknown): value is PageVisibility {
  return (PAGE_VISIBILITIES as readonly unknown[]).includes(value);
}

/** A property's setting; "show" when it has none. */
export function pageVisibilityOf(prop: { options: { pageVisibility?: PageVisibility } }): PageVisibility {
  return isPageVisibility(prop.options.pageVisibility) ? prop.options.pageVisibility : "show";
}

/**
 * Splits a row page's properties into the ones it shows and the ones behind "more properties",
 * each in the order given. `isEmpty` says whether the row has no value for a property; a value the
 * viewer may not see counts as one (a lock shows for it).
 */
export function rowPageSections<P extends { id: string; options: { pageVisibility?: PageVisibility } }>(
  props: P[],
  isEmpty: (prop: P) => boolean,
): { shown: P[]; more: P[] } {
  const shown: P[] = [];
  const more: P[] = [];
  for (const prop of props) {
    const visibility = pageVisibilityOf(prop);
    const hide = visibility === "hide" || (visibility === "hide_empty" && isEmpty(prop));
    (hide ? more : shown).push(prop);
  }
  return { shown, more };
}

/**
 * A stored value that holds nothing: missing, blank text, an unticked box or an empty list. For
 * places without the property cells' finer check (published rows and their print, which show only
 * the properties a row page shows before "more properties" is opened).
 */
export function holdsNothing(value: unknown): boolean {
  return value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
}
