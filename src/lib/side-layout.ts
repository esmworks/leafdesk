/*
 * Boxes beside a chat's column on a wide page (the agent's page, the AI chat): what the
 * conversation holds, at a glance. The page's root is the container (`SIDE_CONTAINER`); the boxes'
 * column shows only once it is wide enough for both (`SIDE_SHOWN`), so the chat never gets
 * narrower than it reads well, and what they replace hides then (`SIDE_HIDDEN`). Below that, and
 * whenever a panel beside the page narrows it, the page is as it was. The boxes themselves are
 * components/side-box.tsx, loaded with what fills them; these classes stay apart for the pages'
 * first load.
 */
export const SIDE_CONTAINER = "@container/side";
export const SIDE_SHOWN = "hidden @min-[64rem]/side:flex";
export const SIDE_HIDDEN = "@min-[64rem]/side:hidden";
/**
 * Where the boxes lie over a scrolling list (the AI chat), so its scrollbar stays at the window's
 * edge: the list's column takes this much room on its end side (`pe-(--side-pad)`), the boxes'
 * width and the room left for the scrollbar.
 */
export const SIDE_PAD = "[--side-pad:0px] @min-[64rem]/side:[--side-pad:19rem]";
/** The boxes' column: its width and the room between the boxes. */
export const SIDE_COLUMN = "w-72 shrink-0 flex-col gap-3";
