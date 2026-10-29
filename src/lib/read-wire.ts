/**
 * How `/api/read` (app/api/read) carries arguments and results: JSON, keeping dates as dates and
 * `undefined` in arrays as `undefined` (a left-out argument gets its default) the way server
 * actions do. Maps, sets and bigints have no form here; writing one throws, so a read returning one
 * fails at once instead of arriving changed.
 */
const DATE = "__leafdeskDate";
const UNDEFINED = "__leafdeskUndefined";

export function encodeRead(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, function (this: unknown, key, written: unknown) {
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date) return { [DATE]: raw.getTime() };
    if (raw === undefined && Array.isArray(this)) return { [UNDEFINED]: 1 };
    if (raw instanceof Map || raw instanceof Set || typeof raw === "bigint") throw new TypeError(`read-wire: "${key}" has no JSON form`);
    return written;
  });
}

export function decodeRead(text: string): unknown {
  if (text === "") return undefined;
  return JSON.parse(text, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const keys = Object.keys(value);
    if (keys.length !== 1) return value;
    const tagged = (value as Record<string, unknown>)[keys[0]];
    if (keys[0] === DATE && typeof tagged === "number") return new Date(tagged);
    // Returned from a reviver, undefined leaves an empty slot in an array, which reads as undefined.
    if (keys[0] === UNDEFINED) return undefined;
    return value;
  });
}
