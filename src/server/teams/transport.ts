import { htmlToPlain, htmlToTeamsMarkdown } from "@/lib/teams-format";
import { escapeHtml } from "@/lib/telegram-format";
import { ChannelError, type Buttons, type Transport } from "@/server/chat-apps/transport";
import { sendActivity, TeamsApiError, updateActivity, type OutgoingActivity } from "./api";
import { serviceUrlOf } from "./conversations";

/**
 * Microsoft Teams as a chat app of the bot (server/chat-apps): the core's HTML goes as the
 * Markdown Teams shows in a bot's message (lib/teams-format.ts); buttons are an Adaptive Card of
 * action sets under the text (a press comes back as a message with the button's data in `value`,
 * events.ts); a message with buttons is replaced in place when they go. Teams has no toast for a
 * press, so a notice comes as a message; "typing…" is the typing activity; a note asked for is the
 * person's next message (`takeAsked`). Files: Teams hands a bot a download address of its own
 * with each file and takes files from a bot only after a consent card; the bot does neither (an
 * address in a call isn't one the bot fetches), so it sends and reads none.
 */

const CARD = "application/vnd.microsoft.card.adaptive";
/** Teams holds a message to about 28 KB; the text goes in pieces well under it. */
const MESSAGE_CHARS = 3_500;
const LABEL_CHARS = 100;
const ASK_TTL_MS = 10 * 60_000;

type Action = Record<string, unknown>;

/** The Adaptive Card of the bot's buttons: one action set per row. */
export function buttonCard(buttons: Buttons): Record<string, unknown> | null {
  const body = buttons
    .filter((row) => row.length)
    .map((row) => ({
      type: "ActionSet",
      actions: row.map(
        (b): Action =>
          b.url
            ? { type: "Action.OpenUrl", title: b.text.slice(0, LABEL_CHARS) || "·", url: b.url }
            : { type: "Action.Submit", title: b.text.slice(0, LABEL_CHARS) || "·", data: { leafdesk: b.data ?? "" } },
      ),
    }));
  if (!body.length) return null;
  return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body };
}

/**
 * A message of the bot's as an activity: its text as Markdown, a notification's `summary` without
 * what a lock screen shouldn't show, and the buttons' card (an empty list of attachments when
 * there are none, so a replacement takes an earlier card away).
 */
export function teamsMessage(text: string, { buttons, plain }: { buttons?: Buttons; plain?: boolean } = {}): OutgoingActivity {
  const html = plain ? escapeHtml(text) : text;
  const card = buttons ? buttonCard(buttons) : null;
  return {
    type: "message",
    text: htmlToTeamsMarkdown(html).slice(0, 27_000) || " ",
    textFormat: "markdown",
    summary: htmlToPlain(html, { hideSpoilers: true }).slice(0, 400) || " ",
    attachments: card ? [{ contentType: CARD, content: card }] : [],
  };
}

/** The messages the bot sent or was pressed on lately: their HTML, to say again without their buttons (Teams can't be asked for it). */
const sent = new Map<string, string>();
const MAX_SENT = 2_000;
export function remember(chat: string, id: string, html: string) {
  sent.delete(`${chat}:${id}`);
  sent.set(`${chat}:${id}`, html);
  if (sent.size > MAX_SENT) sent.delete(sent.keys().next().value!);
}
/** What the bot said in a message, as plain text, when it still knows (a button press carries none). */
export const sentText = (chat: string, id: string): string | null => {
  const html = sent.get(`${chat}:${id}`);
  return html === undefined ? null : htmlToPlain(html);
};

/** Notes asked for, by chat: the person's next message answers the bot's message `key`. */
const asked = new Map<string, { key: string; until: number }>();
/** The message a chat's next text answers, once: the key `askForReply` gave; null when none was asked for (or it ran out). */
export function takeAsked(chat: string): string | null {
  const found = asked.get(chat);
  asked.delete(chat);
  return found && found.until > Date.now() ? found.key : null;
}
/** A command answers no question: the bot's ask for a note is let go. */
export const dropAsked = (chat: string) => void asked.delete(chat);

async function where(chat: string, method: string): Promise<string> {
  const url = await serviceUrlOf(chat);
  if (!url) throw new TeamsApiError(method, "other", "no_service_url");
  return url;
}

const unsupported = (method: string) => new ChannelError("teams", method, "badRequest", "files aren't carried in Teams");

export const teamsTransport: Transport = {
  channel: "teams",
  name: "Microsoft Teams",
  canEdit: true,
  canType: true,
  messageLimit: MESSAGE_CHARS,
  commandPrefix: "/",
  linkCommand: "link",

  async send(chat, text, options = {}) {
    const id = await sendActivity(await where(chat, "send"), chat, teamsMessage(text, options), options.replyTo);
    if (id) remember(chat, id, options.plain ? escapeHtml(text) : text);
    return id;
  },

  async edit(chat, messageId, text, buttons) {
    await updateActivity(await where(chat, "update"), chat, messageId, teamsMessage(text, { buttons }));
    remember(chat, messageId, text);
  },

  async editButtons(chat, messageId, buttons) {
    // What it said is kept in memory only: after a restart its buttons stay (answering them still works).
    const html = sent.get(`${chat}:${messageId}`);
    if (html === undefined) return;
    await updateActivity(await where(chat, "update"), chat, messageId, teamsMessage(html, { buttons }));
  },

  async typing(chat) {
    await sendActivity(await where(chat, "typing"), chat, { type: "typing" });
  },

  async answerButton(press, notice) {
    if (notice) await teamsTransport.send(press.chat.id, escapeHtml(notice));
  },

  async askForReply(chat, prompt, _placeholder, about) {
    asked.set(chat, { key: about, until: Date.now() + ASK_TTL_MS });
    await teamsTransport.send(chat, prompt);
    return about;
  },

  async downloadFile() {
    throw unsupported("downloadFile");
  },

  async sendDocument() {
    throw unsupported("sendDocument");
  },
};
