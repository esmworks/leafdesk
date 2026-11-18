import { teamsToText } from "@/lib/teams-format";
import { COMMANDS, commandOf, handleEvent } from "@/server/chat-apps/bot";
import type { ChatEvent, IncomingMessage } from "@/server/chat-apps/transport";
import { env } from "@/lib/env";
import { trustedServiceUrl } from "./config";
import { rememberServiceUrl } from "./conversations";
import { dropAsked, sentText, takeAsked, teamsTransport } from "./transport";

/**
 * What Teams' calls bring (endpoint.ts) as the chat-app bot's events (server/chat-apps/bot.ts): a
 * message in a personal chat with the bot, a press of one of its buttons (a message whose `value`
 * holds the button's data, which only the bot's own cards carry). Chats other than a personal one
 * are never answered but for a command (answered there, "I only answer in a direct message").
 * Teams hands a bot no slash commands: a command is a message that starts with `/`, or a message
 * that is one command alone (`new`, `help`; `link <code>` for the link code), so a question that
 * only starts with such a word stays a question.
 */

export type Activity = {
  type?: unknown;
  id?: unknown;
  serviceUrl?: unknown;
  channelId?: unknown;
  locale?: unknown;
  text?: unknown;
  value?: unknown;
  replyToId?: unknown;
  from?: { id?: unknown; name?: unknown };
  conversation?: { id?: unknown; conversationType?: unknown; tenantId?: unknown };
  channelData?: { tenant?: { id?: unknown } };
};

const str = (value: unknown, max = 500): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

/** A command written without its slash: the whole message, a known word (`link` with its code, `new` with `summary`). */
const BARE = new Set<string>(COMMANDS);
export function bareCommand(text: string): { command: string; rest: string } | null {
  const words = text.trim().split(/\s+/);
  const word = words[0]?.toLowerCase() ?? "";
  if (word === "link" && words.length === 2 && /^[\w-]{16,64}$/.test(words[1])) return { command: "link", rest: words[1] };
  if (word === "new" && words.length === 2 && words[1].toLowerCase() === "summary") return { command: "new", rest: "summary" };
  return words.length === 1 && BARE.has(word) ? { command: word, rest: "" } : null;
}

/** A message as the bot's event; null for one it never answers. */
export function eventOf(activity: Activity): ChatEvent | null {
  const chat = str(activity.conversation?.id, 400);
  const person = str(activity.from?.id, 200);
  if (activity.type !== "message" || !chat || !person) return null;
  const from = {
    id: person,
    name: str(activity.from?.name, 200) ?? "",
    username: null,
    ...(str(activity.locale, 35) ? { languageCode: str(activity.locale, 35)! } : {}),
  };
  const value = activity.value;
  const data = value && typeof value === "object" ? (value as { leafdesk?: unknown }).leafdesk : undefined;
  if (typeof data === "string") {
    const messageId = str(activity.replyToId, 200);
    if (!data || data.length > 200 || !messageId) return null;
    return { kind: "button", from, chat: { id: chat }, messageId, messageText: sentText(chat, messageId) ?? "", data, callbackId: str(activity.id, 200) ?? "" };
  }
  const text = typeof activity.text === "string" ? teamsToText(activity.text.slice(0, 20_000)) : "";
  const command = text.startsWith("/") ? commandOf(text) : bareCommand(text);
  const message: IncomingMessage = {
    kind: "message",
    from,
    chat: { id: chat, private: activity.conversation?.conversationType === "personal" },
    text: command ? "" : text,
    command,
  };
  // The person's next message answers a note the bot asked for (a command answers nothing).
  if (command) dropAsked(chat);
  else if (text) {
    const key = takeAsked(chat);
    if (key) message.replyTo = key;
  }
  return message;
}

/** Whether a call comes from this server's tenant (a single-tenant bot answers no other directory's people). */
export const fromOurTenant = (activity: Activity) => {
  const tenant = str(activity.channelData?.tenant?.id, 100) ?? str(activity.conversation?.tenantId, 100);
  return Boolean(tenant && env.teamsTenantId && tenant.toLowerCase() === env.teamsTenantId.toLowerCase());
};

/** Handles one verified activity; never throws. */
export async function handleActivity(activity: Activity): Promise<void> {
  try {
    if (!fromOurTenant(activity) || !trustedServiceUrl(activity.serviceUrl)) return;
    const chat = str(activity.conversation?.id, 400);
    const person = str(activity.from?.id, 200);
    if (!chat || !person) return;
    await rememberServiceUrl(chat, activity.serviceUrl as string, person);
    const event = eventOf(activity);
    if (event) await handleEvent(teamsTransport, event);
    // A link this call made has its chat's address kept now.
    await rememberServiceUrl(chat, activity.serviceUrl as string, person);
  } catch (error) {
    console.error("[teams] activity failed", error instanceof Error ? error.message : error);
  }
}
