/**
 * Comparing Leafdesk's release versions (server/update-check.ts): `1.2.3`, with or without a
 * leading `v`, and prereleases (`1.2.3-beta.1`), which come before their release. Pure.
 */

type Version = { core: [number, number, number]; pre: (number | string)[] };

/** The version a tag names, or null for anything that isn't one (a missing part, words). */
export function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const pre = match[4] ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
  if (pre.some((part) => part === "")) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

function comparePre(a: (number | string)[], b: (number | string)[]) {
  // A release comes after its prereleases.
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    // Numbers come before words, as semver orders them.
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1 as `a` comes before, with or after `b`; null when either isn't a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre) as -1 | 0 | 1;
}

/** Whether `latest` is a later version than `running`; false when either can't be read. */
export const isNewerVersion = (latest: string, running: string) => compareVersions(latest, running) === 1;

/** A tag as it is shown: without its `v`. */
export const versionLabel = (tag: string) => tag.trim().replace(/^v/, "");
