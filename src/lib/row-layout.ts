/**
 * How a database's row pages lay out its properties, the same for everyone who opens a row (in the
 * side panel and on the row's own page) and set by people with full access to the database:
 *
 * - up to MAX_PINNED properties sit in a compact strip under the row's title (PropertyOptions
 *   `pinned`), whatever their row page visibility (lib/page-visibility) says;
 * - the others show above the body (the default) or, with the database's `propertiesBeside`, in a
 *   column beside it where the page is wide enough, above it where it isn't (a phone, the panel).
 *
 * Pure and client-safe.
 */

/** Properties a row page pins under its title. */
export const MAX_PINNED = 4;

export const isPinned = (prop: { options: { pinned?: true } }) => prop.options.pinned === true;

/** The properties pinned under the title (the first MAX_PINNED, in order) and the others, in order. */
export function pinnedSplit<P extends { options: { pinned?: true } }>(props: P[]): { pinned: P[]; rest: P[] } {
  const pinned: P[] = [];
  const rest: P[] = [];
  for (const prop of props) (isPinned(prop) && pinned.length < MAX_PINNED ? pinned : rest).push(prop);
  return { pinned, rest };
}

/** Whether `propertyId` may be pinned among `props` (the database's properties): it is, or there is room. */
export function canPin(props: { id: string; options: { pinned?: true } }[], propertyId: string): boolean {
  return props.some((p) => p.id === propertyId && isPinned(p)) || props.filter(isPinned).length < MAX_PINNED;
}
