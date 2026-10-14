/**
 * An app's tile in the lists of connected apps: the first letter of its name. Never the icon the
 * app registered: that is a URL anyone registering a client chooses, and loading it would tell
 * them who looked at the list and when.
 */
export function AppTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-sm font-semibold text-fg-muted"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
