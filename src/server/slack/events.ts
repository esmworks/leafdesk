import { env } from "@/lib/env";
import { htmlToMrkdwn, mrkdwnToText } from "@/lib/slack-format";
import { handleEvent } from "@/server/chat-apps/bot";
import type { ChatEvent, IncomingMessage, Sender } from "@/server/chat-apps/transport";
import { callSlack, type SlackFile, type SlackUser } from "./api";
import { remember, slackTransport } from "./transport";

/**
 * What Socket Mode brings (socket.ts) as the chat-app bot's events (server/chat-apps/bot.ts):
 * direct messages to the bot (`message` in an `im`, never a bot's, an edit or another subtype but a
 * file shared), presses of its buttons (`block_actions`) and its slash command, `/leafdesk
 * <command> [rest]`, since Slack's apps take every message starting with `/` for their own.
 * Messages in channels and group conversations are never answered; a command typed there is
 * answered where only its writer sees it (the command's response_url).
 */

/** Each person's direct message with the bot (conversations.open), asked once per process. */
const ims = new Map<string, Promise<string | null>>();
export function imOf(userId: string): Promise<string | null> {
  let found = ims.get(userId);
  if (!found) {
    found = callSlack<{ channel?: { id?: string } }>("conversations.open", { users: userId }).then(
      (answer) => answer.channel?.id ?? null,
      () => {
        ims.delete(userId);
        return null;
      },
    );
    ims.set(userId, found);
  }
  return found;
}

/** A person as the bot greets them and the settings show them (users.info; their id alone when it fails). */
async function senderOf(userId: string): Promise<Sender> {
  try {
    const { user } = await callSlack<{ user?: SlackUser }>("users.info", { user: userId, include_locale: true });
    return {
      id: userId,
      name: user?.profile?.display_name || user?.real_name || user?.profile?.real_name || user?.name || "",
      username: user?.name ?? null,
      ...(user?.locale ? { languageCode: user.locale } : {}),
    };
  } catch {
    return { id: userId, name: "", username: null };
  }
}

type MessageEvent = {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
};

/** A message event as the bot's; null for one it never answers (a bot's, an edit, a join …). */
export function messageOf(event: MessageEvent): IncomingMessage | null {
  if (event.type !== "message" || !event.user || !event.channel || event.bot_id) return null;
  if (event.subtype && event.subtype !== "file_share") return null;
  const files = event.files ?? [];
  const audio = files.find((f) => f.mimetype?.startsWith("audio/") || f.subtype === "slack_audio");
  const other = files.find((f) => f !== audio);
  const ref = (f: SlackFile) => f.url_private_download ?? f.url_private ?? "";
  return {
    kind: "message",
    from: { id: event.user, name: "", username: null },
    chat: { id: event.channel, private: event.channel_type === "im" },
    text: mrkdwnToText(event.text ?? "").trim(),
    command: null,
    ...(audio ? { voice: { ref: ref(audio), duration: Math.ceil((audio.duration_ms ?? 0) / 1000), mimeType: audio.mimetype } } : {}),
    ...(other ? { document: { ref: ref(other), name: other.name ?? other.title, mimeType: other.mimetype, size: other.size } } : {}),
    ...(event.thread_ts && event.thread_ts !== event.ts ? { replyTo: event.thread_ts } : {}),
  };
}

type SlashCommand = { command?: string; text?: string; user_id?: string; channel_id?: string; response_url?: string };

/** The slash command's text as a command: `link abc` → link, "abc"; nothing → help. */
export function commandIn(text: string): { command: string; rest: string } {
  const match = /^\s*(\S+)\s*([\s\S]*)$/.exec(text);
  return match ? { command: match[1].toLowerCase().replace(/^\//, ""), rest: match[2].trim() } : { command: "help", rest: "" };
}

/** Answers a command where it was typed, seen by its writer alone (only to Slack's own response addresses). */
async function respondTo(url: string, html: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.origin !== "https://hooks.slack.com" && parsed.origin !== new URL(env.slackApiUrl).origin) return;
  await fetch(parsed, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text: htmlToMrkdwn(html) }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {});
}

/** The slash command as the bot's message: in the person's direct message with the bot, private; elsewhere answered in place. */
export async function commandOf(payload: SlashCommand): Promise<IncomingMessage | null> {
  if (!payload.user_id || !payload.channel_id) return null;
  const [im, from] = await Promise.all([imOf(payload.user_id), senderOf(payload.user_id)]);
  const responseUrl = payload.response_url;
  return {
    kind: "message",
    from,
    chat: { id: payload.channel_id, private: im === payload.channel_id },
    text: "",
    command: commandIn(payload.text ?? ""),
    ...(responseUrl ? { respond: (html: string) => respondTo(responseUrl, html) } : {}),
  };
}

type BlockActions = {
  type?: string;
  user?: { id?: string; username?: string; name?: string };
  channel?: { id?: string };
  container?: { message_ts?: string; channel_id?: string };
  message?: { ts?: string; text?: string; blocks?: Record<string, unknown>[] };
  actions?: { action_id?: string; value?: string; action_ts?: string }[];
  trigger_id?: string;
};

/** A press of one of the bot's buttons; null for anything else (a press on a link button has no value). */
export function pressOf(payload: BlockActions): ChatEvent | null {
  const action = payload.actions?.[0];
  const chat = payload.channel?.id ?? payload.container?.channel_id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  if (payload.type !== "block_actions" || !action?.value || !payload.user?.id || !chat || !ts) return null;
  if (payload.message?.blocks) remember(chat, ts, payload.message.blocks);
  return {
    kind: "button",
    from: { id: payload.user.id, name: payload.user.name ?? "", username: payload.user.username ?? null },
    chat: { id: chat },
    messageId: ts,
    messageText: mrkdwnToText(payload.message?.text ?? ""),
    data: action.value,
    callbackId: payload.trigger_id ?? action.action_ts ?? "",
  };
}

/** Handles one envelope's payload; never throws. */
export async function handleEnvelope(type: string, payload: unknown): Promise<void> {
  try {
    let event: ChatEvent | null = null;
    if (type === "events_api") event = messageOf(((payload ?? {}) as { event?: MessageEvent }).event ?? {});
    else if (type === "interactive") event = pressOf((payload ?? {}) as BlockActions);
    else if (type === "slash_commands") event = await commandOf((payload ?? {}) as SlashCommand);
    if (event) await handleEvent(slackTransport, event);
  } catch (error) {
    console.error("[slack] event failed", error instanceof Error ? error.message : error);
  }
}
