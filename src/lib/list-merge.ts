/**
 * A list value (tags, people, linked rows, files) as one person's edit leaves it when someone else
 * changed the same list after they read it: what they added and took away, applied to the list as
 * it is now, so two people adding a tag at once both keep theirs. Items are told apart by their
 * JSON. `base` is the list the edit started from; with nobody else's change between, the edit
 * stands as written (its order too).
 */
export function mergeListEdit(current: unknown, base: unknown, next: unknown): unknown[] {
  const key = (value: unknown) => JSON.stringify(value);
  const now = asList(current);
  const was = asList(base);
  const wanted = asList(next);
  if (sameList(now, was)) return wanted;
  const wasKeys = new Set(was.map(key));
  const wantedKeys = new Set(wanted.map(key));
  const removed = new Set([...wasKeys].filter((k) => !wantedKeys.has(k)));
  const kept = now.filter((value) => !removed.has(key(value)));
  const keptKeys = new Set(kept.map(key));
  const added = wanted.filter((value) => !wasKeys.has(key(value)) && !keptKeys.has(key(value)));
  return [...kept, ...added];
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sameList(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((value, i) => JSON.stringify(value) === JSON.stringify(b[i]));
}
