/**
 * Polls in team messages (server/messages/polls.ts, components/messages/poll-*.tsx): their limits,
 * how a poll's settings are checked, whether it still takes votes and how a vote changes what a
 * person sees before the server answers. No imports, for the browser and the server alike.
 */

export const POLL_LIMITS = {
  /** Characters of the question, which is also the message's text. */
  question: 300,
  /** Characters of one option. */
  option: 100,
  minOptions: 2,
  maxOptions: 10,
  /** How far ahead a poll may close. */
  closesWithinMs: 366 * 24 * 60 * 60_000,
} as const;

/** A poll's choice as stored: its id, given by the server, and its words. */
export type PollOption = { id: string; text: string };

/** A poll as sent, checked: what `message_poll` keeps. */
export type PollSettings = { question: string; options: PollOption[]; multiple: boolean; anonymous: boolean; closesAt: Date | null };

export type PollInputError = "question" | "questionTooLong" | "tooFewOptions" | "tooManyOptions" | "optionTooLong" | "duplicateOptions" | "closesAt";

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
/** Options are the same when they read the same, case aside. */
const sameKey = (text: string) => text.normalize("NFC").toLowerCase();

/** What is wrong with a poll being written, or null: the dialog shows it, the server refuses it. */
export function pollInputError(input: { question: string; options: string[]; closesAt?: Date | null }, now = Date.now()): PollInputError | null {
  const question = clean(input.question);
  if (!question) return "question";
  if (question.length > POLL_LIMITS.question) return "questionTooLong";
  const options = input.options.map(clean).filter(Boolean);
  if (options.length < POLL_LIMITS.minOptions) return "tooFewOptions";
  if (options.length > POLL_LIMITS.maxOptions) return "tooManyOptions";
  if (options.some((o) => o.length > POLL_LIMITS.option)) return "optionTooLong";
  if (new Set(options.map(sameKey)).size !== options.length) return "duplicateOptions";
  const closesAt = input.closesAt;
  if (closesAt && (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= now || closesAt.getTime() > now + POLL_LIMITS.closesWithinMs)) return "closesAt";
  return null;
}

/**
 * A poll from a client, checked and made into what is stored, or the reason it can't be. Empty
 * options are dropped; the options get their ids here, never from the client.
 */
export function readPollInput(value: unknown, now = Date.now(), newId: () => string = () => crypto.randomUUID().slice(0, 8)): PollSettings | PollInputError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "question";
  const v = value as Record<string, unknown>;
  if (typeof v.question !== "string" || !Array.isArray(v.options)) return "question";
  if (v.options.length > POLL_LIMITS.maxOptions * 3) return "tooManyOptions";
  if (v.options.some((o) => typeof o !== "string")) return "tooFewOptions";
  if (v.multiple !== undefined && typeof v.multiple !== "boolean") return "question";
  if (v.anonymous !== undefined && typeof v.anonymous !== "boolean") return "question";
  let closesAt: Date | null = null;
  if (v.closesAt !== undefined && v.closesAt !== null) {
    if (typeof v.closesAt !== "string") return "closesAt";
    closesAt = new Date(v.closesAt);
  }
  const options = (v.options as string[]).map(clean).filter(Boolean);
  const error = pollInputError({ question: v.question, options, closesAt }, now);
  if (error) return error;
  const ids = new Set<string>();
  return {
    question: clean(v.question),
    options: options.map((text) => {
      let id = newId();
      while (ids.has(id)) id = newId();
      ids.add(id);
      return { id, text };
    }),
    multiple: v.multiple === true,
    anonymous: v.anonymous === true,
    closesAt,
  };
}

/** What decides whether a poll still takes votes. */
export type PollTimes = { closesAt: string | null; closedAt: string | null };

/** Closed by someone, or past the time it was set to close. */
export function pollClosed(poll: PollTimes, now: number = Date.now()): boolean {
  return Boolean(poll.closedAt) || (poll.closesAt !== null && new Date(poll.closesAt).getTime() <= now);
}

/** A poll as a reader sees it: counts, who chose each option (null when anonymous), and their own choices. */
export type PollCounts = {
  options: { id: string; text: string; count: number; voters: string[] | null }[];
  multiple: boolean;
  anonymous: boolean;
  /** People who chose anything. */
  voters: number;
  mine: string[];
};

/**
 * The poll after the reader chooses `optionId` (or takes it back, `on` false), as it will be once
 * the server agrees: one choice replaces another unless several are allowed.
 */
export function withVote<P extends PollCounts>(poll: P, me: string, optionId: string, on: boolean): P {
  if (!poll.options.some((o) => o.id === optionId)) return poll;
  const before = new Set(poll.mine);
  const after = new Set(on ? (poll.multiple ? [...before, optionId] : [optionId]) : [...before].filter((id) => id !== optionId));
  const options = poll.options.map((o) => {
    const had = before.has(o.id);
    const has = after.has(o.id);
    if (had === has) return o;
    return {
      ...o,
      count: Math.max(0, o.count + (has ? 1 : -1)),
      voters: o.voters === null ? null : has ? [...o.voters.filter((id) => id !== me), me] : o.voters.filter((id) => id !== me),
    };
  });
  const voters = poll.voters + (after.size > 0 ? 1 : 0) - (before.size > 0 ? 1 : 0);
  return { ...poll, options, voters: Math.max(0, voters), mine: poll.options.filter((o) => after.has(o.id)).map((o) => o.id) };
}

/** An option's share of the people who voted, rounded to a whole percent. */
export function pollShare(count: number, voters: number): number {
  return voters > 0 ? Math.round((count / voters) * 100) : 0;
}
