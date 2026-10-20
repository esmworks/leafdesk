/** Tints a tile can take; text and ground of each read 4.5:1 or more in either theme. */
const TINTS = [
  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-800 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-800 dark:text-orange-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
];

/** The same name always gets the same tint, so an app looks alike wherever it is listed. */
function tintOf(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

/**
 * An app's tile in the lists of connected apps: the first letter of its name on a tint taken from
 * the name, so two apps that start alike still look apart. Never the icon the app registered: that
 * is a URL anyone registering a client chooses, and loading it would tell them who looked at the
 * list and when.
 */
export function AppTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[22%] text-base font-semibold high-contrast:border high-contrast:border-border high-contrast:bg-bg high-contrast:text-fg ${tintOf(name)}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
