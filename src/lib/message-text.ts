/**
 * The words of a message (channel_message.body): Markdown in which a person, a channel, a page and
 * everyone are links with an address of their own, so the text stays readable anywhere (an export,
 * MCP, an email) and the app draws them as chips by what each reader may see:
 *
 * - `[@Ayşe](leafdesk:user/<userId>)` a person, notified when the message comes;
 * - `[@here](leafdesk:here)` everyone in the channel who is online, `[@channel](leafdesk:everyone)` everyone in it;
 * - `[#design](leafdesk:channel/<channelId>)` a channel;
 * - `[Plan](leafdesk:page/<pageId>)` a page, shown with its current title to those who may open it.
 *
 * The words inside the brackets are what the writer saw; readers see the current name.
 */

export const MENTION_SCHEME = "leafdesk:";

export type MessageRef =
  | { kind: "user"; id: string }
  | { kind: "channel"; id: string }
  | { kind: "page"; id: string }
  | { kind: "here" }
  | { kind: "everyone" };

/** What a `leafdesk:` address stands for, or null for any other address. */
export function messageRef(href: string | null | undefined): MessageRef | null {
  if (!href?.startsWith(MENTION_SCHEME)) return null;
  const rest = href.slice(MENTION_SCHEME.length);
  if (rest === "here") return { kind: "here" };
  if (rest === "everyone") return { kind: "everyone" };
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (kind === "user" || kind === "channel" || kind === "page") return { kind, id };
  return null;
}

/** Writes a reference as the Markdown link the body keeps. `label` loses the characters that would end the link. */
export function refLink(ref: MessageRef, label: string): string {
  const text = label.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim() || "…";
  const href = ref.kind === "here" || ref.kind === "everyone" ? `${MENTION_SCHEME}${ref.kind}` : `${MENTION_SCHEME}${ref.kind}/${ref.id}`;
  return `[${text}](${href})`;
}

// A link: [text](address), the text without brackets inside, the address without spaces or ")".
const LINK = /\[([^\]\n]{0,200})\]\(([^)\s]{1,2048})\)/g;
// Code spans and blocks: references inside them are words, not mentions.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** The body without its code, where references count. */
const outsideCode = (body: string) => body.replace(CODE, " ");

/** Every reference the body makes outside code, in order, each once. */
export function messageRefs(body: string): MessageRef[] {
  const seen = new Set<string>();
  const refs: MessageRef[] = [];
  for (const match of outsideCode(body).matchAll(LINK)) {
    const ref = messageRef(match[2]);
    if (!ref) continue;
    const key = "id" in ref ? `${ref.kind}/${ref.id}` : ref.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

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

/** The people the body names. */
export const mentionedUserIds = (body: string): string[] => messageRefs(body).flatMap((r) => (r.kind === "user" ? [r.id] : []));

/** The pages the body links. */
export const linkedPageIds = (body: string): string[] => messageRefs(body).flatMap((r) => (r.kind === "page" ? [r.id] : []));

/** Whether the body calls everyone in the channel (`everyone`) or those online (`here`); `everyone` wins. */
export function broadcastOf(body: string): "everyone" | "here" | null {
  const refs = messageRefs(body);
  if (refs.some((r) => r.kind === "everyone")) return "everyone";
  if (refs.some((r) => r.kind === "here")) return "here";
  return null;
}

/**
 * The body as people read it, one line per line, without Markdown's marks: for search, a
 * notification, the line under a channel in a list. References keep their words; other links their
 * text, and their address when the text is not it.
 */
export function plainText(body: string): string {
  return body
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(LINK, (_, text: string, href: string) => (messageRef(href) || text === href || !text ? text || href : `${text} (${href})`))
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^\n*_]*?\S)[*_](?!\w)/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first words of a body, on one line, for a list or a notification. */
export function snippet(body: string, max = 140): string {
  const text = plainText(body).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Whether a body holds anything once spaces are gone (a message needs words or a file). */
export const hasWords = (body: string) => body.trim().length > 0;
