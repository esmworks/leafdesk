import type { Dictionary } from "@blocknote/core";
import { he as blocknoteHebrew } from "@blocknote/core/locales";

/** BlockNote's Hebrew, with resolving a comment thread said as resolving it (not "mark button"). */
export const he: Dictionary = {
  ...blocknoteHebrew,
  comments: {
    ...blocknoteHebrew.comments,
    actions: { ...blocknoteHebrew.comments.actions, resolve: "סמן כנפתר" },
    sidebar: { ...blocknoteHebrew.comments.sidebar, marked_as_resolved: "סומן כנפתר" },
  },
};
