/**
 * Message bodies made quiet, in a module of its own: lib/message-text.ts is in the Messages page's
 * first load, and only the server needs this.
 */
import { CODE, LINK, messageRef } from "./message-text";

/**
 * The body with its mentions of people and its @here / @channel as plain words: for words no person
 * typed (an agent's answer, server/agents/run.ts), which must not notify anyone by themselves.
 * Channels and pages stay links: they tell no one.
 */
export function withoutCalls(body: string): string {
  const quiet = (part: string) =>
    part.replace(LINK, (whole, text: string, href: string) => {
      const ref = messageRef(href);
      return ref && (ref.kind === "user" || ref.kind === "here" || ref.kind === "everyone") ? text : whole;
    });
  // Code keeps its words as they are: references there are no mentions anyway.
  let out = "";
  let at = 0;
  for (const match of body.matchAll(CODE)) {
    out += quiet(body.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + quiet(body.slice(at));
}
