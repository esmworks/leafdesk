/**
 * Whether a web call the model makes (`read_web_page`, `search_web`) sends only what a person wrote
 * themselves. Whatever the call carries leaves the workspace: the address reaches the site that
 * serves it, the words the search service. Text the model read in the workspace (or anywhere) could
 * steer it into putting what it read there, so the AI chat asks the person before each web call
 * (ai-chat.ts), and an agent's run a person asked for in words waits for an owner (agents/run.ts),
 * except where the call carries nothing the person didn't write: a page whose address they typed,
 * or (agents) a search with words of their message. A schedule's run, which no one watches, reads
 * only pages of its task or its own searches, and refuses others at once.
 */
import { WEB_TOOL_NAMES } from "@/lib/agents";
import type { ChatActionView } from "@/lib/ai-chat";

/** Characters around an address in text: never part of it. */
const AROUND = /[\s<>"'`()[\]{}|\\^]+/;
/** Punctuation that ends a sentence after an address. */
const TRAILING = /[.,;:!?…]+$/;
/** A token that is an address without its scheme: a host name with a dot, then a port, path, query or nothing. */
const BARE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}(?::\d+)?(?:[/?#]|$)/i;

/** An address as a call sends it, without its scheme: host, port, path, query and fragment. */
function addressKey(url: URL): string {
  const path = url.pathname === "/" && !url.search && !url.hash ? "" : url.pathname;
  return `${url.hostname}${url.port ? `:${url.port}` : ""}${path}${url.search}${url.hash}`;
}

function parse(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The web addresses in text a person wrote, with or without their scheme. */
export function typedAddresses(text: string): URL[] {
  const found: URL[] = [];
  for (const raw of text.split(AROUND)) {
    const token = raw.replace(TRAILING, "");
    if (!token) continue;
    const url = /^https?:\/\//i.test(token) ? parse(token) : BARE.test(token) ? parse(`https://${token}`) : null;
    if (url && !url.username && !url.password) found.push(url);
  }
  return found;
}

/**
 * Whether reading `address` sends nothing the person didn't write in `typed`: it is an address they
 * wrote (http or https alike), or one of theirs without its query and fragment. Anything added (a
 * path, a query, a sign-in name, another host) makes it another address.
 */
export function addressTyped(address: string, typed: readonly string[]): boolean {
  const url = parse(address.trim());
  if (!url || url.username || url.password) return false;
  return typed.some((text) => typedAddresses(text).some((own) => sameOrShorter(url, own)));
}

/** Whether `url` is `own` (either scheme), or `own` without its query and fragment. */
function sameOrShorter(url: URL, own: URL): boolean {
  const key = addressKey(url);
  if (addressKey(own) === key) return true;
  const bare = new URL(own.href);
  bare.search = "";
  bare.hash = "";
  return addressKey(bare) === key;
}

/**
 * Whether `address` is one of the `found` addresses (a search's results) as addressTyped matches
 * them: the search service chose those before the run read anything, so they carry nothing it read.
 */
export function addressFound(address: string, found: readonly string[]): boolean {
  const url = parse(address.trim());
  if (!url || url.username || url.password) return false;
  return found.some((text) => {
    const own = parse(text);
    return own !== null && sameOrShorter(url, own);
  });
}

/** Text folded for comparing search words: lower case, one space between words. */
const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether a search's words are, as they stand, words the person wrote in `typed` (case and spacing
 * aside), not cut out of a longer word: nothing in them was added, punctuation included.
 */
export function queryTyped(query: string, typed: readonly string[]): boolean {
  const words = fold(query);
  if (!words) return false;
  // A word of the query may not go on into the person's next or previous letters.
  const joins = (edge: string, beside: string | undefined) => beside !== undefined && WORD.test(edge) && WORD.test(beside);
  return typed.some((text) => {
    const own = fold(text);
    for (let at = own.indexOf(words); at >= 0; at = own.indexOf(words, at + 1)) {
      if (!joins(words[0], own[at - 1]) && !joins(words[words.length - 1], own[at + words.length])) return true;
    }
    return false;
  });
}

type WebCall = { name: string; arguments: Record<string, unknown> };

/** What a web call sends, as it is sent: the words of search_web, the address of read_web_page ("" when missing). */
export function webCallTarget(call: WebCall): string {
  if (call.name === WEB_TOOL_NAMES.search) return typeof call.arguments.query === "string" ? call.arguments.query.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  return typeof call.arguments.url === "string" ? call.arguments.url.trim().slice(0, 2_000) : "";
}

/**
 * The AI chat: whether a web call waits for the person's approval. Every one does, except reading
 * a page whose address they wrote in the conversation (`typed`: their questions), and a call that
 * sends nothing (it is refused anyway).
 */
export function chatWebCallAsks(call: WebCall, typed: readonly string[]): boolean {
  const target = webCallTarget(call);
  if (!target) return false;
  return call.name !== WEB_TOOL_NAMES.read || !addressTyped(target, typed);
}

/** A web call the chat asks the person about: the address or the words, exactly as they would go. */
export function webCallAction(call: WebCall): ChatActionView {
  return { action: call.name === WEB_TOOL_NAMES.search ? "searchWeb" : "readWeb", target: null, title: webCallTarget(call), changes: [], content: null };
}

/**
 * An agent's run: whether a web call waits for an owner. On a run whose input no one stands behind
 * (`askEveryTool`) every one does; on one a person asked for in words (`typed`: their message) one
 * that reads an address or searches for words they didn't write does; on others none does.
 */
export function agentWebCallAsks(call: WebCall, run: { askEveryTool: boolean; typed: readonly string[] | null }): boolean {
  if (run.askEveryTool) return true;
  if (!run.typed) return false;
  if (call.name === WEB_TOOL_NAMES.search) return !(typeof call.arguments.query === "string" && queryTyped(call.arguments.query, run.typed));
  return !(typeof call.arguments.url === "string" && addressTyped(call.arguments.url, run.typed));
}

/**
 * A schedule's run, or a helper's run for one (no one watches either): whether a web call may go.
 * A search may: its words reach only the server's search service, which its operators chose. A
 * page read may when its address is in the schedule's task (`typed`: none on a helper's run, whose
 * task an agent wrote) or among the results of the run's own searches (`found`). Any other read is
 * refused at once: waiting for an owner would hold the run until its next time is due.
 */
export function scheduledWebCallGoes(call: WebCall, run: { typed: readonly string[]; found: readonly string[] }): boolean {
  if (call.name === WEB_TOOL_NAMES.search) return true;
  const address = typeof call.arguments.url === "string" ? call.arguments.url : "";
  return addressTyped(address, run.typed) || addressFound(address, run.found);
}
