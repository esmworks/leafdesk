/**
 * A catch-up: what a person missed in a channel or a thread, summed up by the AI
 * (server/messages/catch-up.ts), with the decisions, the questions put to them and what is still
 * open, each pointing at the message it comes from. Shared by the server and the Messages place.
 */

/** One point of a catch-up and the message it comes from (null when the model named none we sent). */
export type CatchUpItem = { text: string; messageId: string | null; threadId: string | null };

export type CatchUp = {
  /** Two or three sentences on what happened. */
  summary: string;
  decisions: CatchUpItem[];
  /** Questions or requests put to the person asking. */
  questions: CatchUpItem[];
  /** What is still open: unanswered questions, things someone will do, problems. */
  open: CatchUpItem[];
  /** How many messages were read. */
  read: number;
  /** How many older ones were left out (more than a catch-up reads). */
  left: number;
};

/** The newest this many messages are read; older unread ones are left out. */
export const CATCH_UP_MAX_MESSAGES = 150;
/** A channel offers a catch-up from this many unread messages on. */
export const CATCH_UP_MIN_UNREAD = 3;
/** A thread offers one from this many replies on. */
export const CATCH_UP_MIN_REPLIES = 8;
/** Points a catch-up lists in each part, at most. */
export const CATCH_UP_MAX_ITEMS = 6;
