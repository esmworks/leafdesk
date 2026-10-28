const chip =
  "flex h-[26px] min-w-0 items-center gap-1.5 rounded-[7px] px-[7px] text-[13px] transition-colors hover:bg-bg-hover aria-expanded:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent";

/** A choice in the chat box's toolbar (what the chat may change, the model), drawn as a borderless chip. */
export const chipTrigger = `${chip} text-fg [&>svg:last-child]:text-fg-muted`;

/** The same, quieter, in the strip above the box (where answers come from). */
export const chipMuted = `${chip} text-fg-muted hover:text-fg aria-expanded:text-fg [&>svg:last-child]:text-fg-faint`;
