/**
 * `next`, with every part that equals the same part of `prev` replaced by prev's object, so memoized
 * components and hooks fed from a reloaded value only redraw where something changed. Items of
 * arrays with an `id` are matched by id (rows that moved, came or went), the rest by index. Order
 * and membership always follow `next`; when nothing changed, `prev` itself comes back.
 */
export function keepUnchanged<T>(prev: T, next: T): T {
  return keep(prev, next) as T;
}

function keep(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (prev instanceof Date && next instanceof Date) return prev.getTime() === next.getTime() ? prev : next;
  if (Array.isArray(prev) && Array.isArray(next)) return keepArray(prev, next);
  if (isPlainObject(prev) && isPlainObject(next)) return keepObject(prev, next);
  return next;
}

function keepArray(prev: unknown[], next: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const item of prev) {
    const id = idOf(item);
    if (id !== undefined) byId.set(id, item);
  }
  let same = prev.length === next.length;
  const out = next.map((item, i) => {
    const id = idOf(item);
    const kept = keep(id !== undefined ? byId.get(id) : prev[i], item);
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

function keepObject(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prev).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = Object.hasOwn(prev, key) ? keep(prev[key], next[key]) : next[key];
    if (kept !== prev[key] || !Object.hasOwn(prev, key)) same = false;
    out[key] = kept;
  }
  return same ? prev : out;
}

function idOf(item: unknown): string | undefined {
  return isPlainObject(item) && typeof item.id === "string" ? item.id : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
