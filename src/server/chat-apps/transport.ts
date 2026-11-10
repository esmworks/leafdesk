/**
 * What the chat-app bot (server/chat-apps) needs of a chat app: a transport sends and changes
 * messages there and turns what comes from there into the events below. Telegram
 * (server/telegram/transport.ts) and Slack (server/slack/transport.ts) are the two. The core never
 * speaks a chat app's own API: every text it hands a transport is the small HTML subset of
 * lib/telegram-format.ts (`<b> <i> <s> <a> <code> <pre> <blockquote>`, `<tg-spoiler>` for what a
 * lock screen shouldn't show, text escaped with escapeHtml), which each transport turns into its
 * own markup.
 */

/** The chat apps a Leafdesk account can link (`channel_link.channel`). */
export const CHAT_CHANNELS = ["telegram", "slack"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/** A button under a message: `data` comes back in a ButtonPress; `url` opens an address instead. */
export type Button = { text: string; data?: string; url?: string };
/** Buttons in rows, as the core lays them out; a transport may fold rows its app can't show. */
export type Buttons = Button[][];

/** Who wrote a message or pressed a button, in the chat app's own terms. */
export type Sender = {
  /** The chat app's id of the person, as text. */
  id: string;
  /** Their name there, to show in the settings and greet them with. */
  name: string;
  username: string | null;
  /** Their app's language (Telegram's language_code), when the app says. */
  languageCode?: string;
};

/** A file a message carries, named by the transport's own reference (a Telegram file_id, a Slack download address). */
export type IncomingFile = { ref: string; name?: string; mimeType?: string; size?: number };
/** A voice message: a file with its length in seconds (0 when the app doesn't say). */
export type IncomingVoice = { ref: string; duration: number; mimeType?: string };

/** A message written to the bot, or a command. */
export type IncomingMessage = {
  kind: "message";
  from: Sender;
  /** Where it was written: `private` only in the person's own chat with the bot, where answers go. */
  chat: { id: string; private: boolean };
  text: string;
  /** A command and what follows it (`/new summary`, in Slack `/leafdesk new summary`), lower case; null for a question. */
  command: { command: string; rest: string } | null;
  /** The text that came with a file. */
  caption?: string;
  voice?: IncomingVoice;
  document?: IncomingFile;
  /** The key (askForReply's) of the bot's question this message answers. */
  replyTo?: string;
  /**
   * Answers where the message was written when that isn't somewhere the bot may send to (a Slack
   * command typed in a channel: seen by its writer alone); else answers go to `chat.id`.
   */
  respond?: (html: string) => Promise<void>;
};

/** A button pressed under one of the bot's messages. */
export type ButtonPress = {
  kind: "button";
  from: Sender;
  chat: { id: string };
  messageId: string;
  /** The message's text as the app has it (plain), for when the bot no longer knows what it said. */
  messageText: string;
  data: string;
  /** The press's own id, for answerButton. */
  callbackId: string;
};

export type ChatEvent = IncomingMessage | ButtonPress;

export type SendOptions = {
  buttons?: Buttons;
  /** A message this one answers: quoted in Telegram, in its thread in Slack. */
  replyTo?: string;
  /** The text is plain, not the HTML subset. */
  plain?: boolean;
};

export type OutgoingFile = { name: string; contentType: string; bytes: Uint8Array };

export interface Transport {
  readonly channel: ChatChannel;
  /** Its name, as people know it. */
  readonly name: string;
  /**
   * Messages can be changed once sent: an answer is shown as it is written and buttons go once
   * answered. Without it the core sends each change as a new message.
   */
  readonly canEdit: boolean;
  /** It can show that the bot is writing ("typing…"). */
  readonly canType: boolean;
  /** The most HTML characters one message carries. */
  readonly messageLimit: number;
  /** What a command is typed with (`/`, Slack's `/leafdesk `): texts naming a command use it. */
  readonly commandPrefix: string;
  /** The command that links an account with a code from the settings (`start`, `link`). */
  readonly linkCommand: string;

  /** Sends a message; its id. */
  send(chat: string, text: string, options?: SendOptions): Promise<string>;
  /** Replaces a message's text, its buttons with `buttons` (none: taken away). */
  edit(chat: string, messageId: string, text: string, buttons?: Buttons): Promise<void>;
  /** Replaces a message's buttons, taking them away when none are given. */
  editButtons(chat: string, messageId: string, buttons?: Buttons): Promise<void>;
  /** Shows for a few seconds that the bot is writing (only called with canType). */
  typing(chat: string): Promise<void>;
  /** Answers a button press, with a short notice for the person when given. */
  answerButton(press: ButtonPress, notice?: string): Promise<void>;
  /**
   * Asks the person to answer `about` (a message of the bot's) with a text of their own: in
   * Telegram a reply box opens, in Slack they answer in the message's thread. The key a message
   * answering it carries in `replyTo`.
   */
  askForReply(chat: string, prompt: string, placeholder: string, about: string): Promise<string>;
  /** Downloads a file a message carries, at most `maxBytes` of it (else ChannelError `tooLarge`). */
  downloadFile(file: IncomingFile | IncomingVoice, maxBytes: number, signal?: AbortSignal): Promise<Blob>;
  /** Sends a file, with a plain caption. */
  sendDocument(chat: string, file: OutgoingFile, caption?: string): Promise<void>;
}

/** Why a chat app refused a call, as the core tells them apart. */
export type ChannelErrorKind =
  /** The token was refused. */
  | "unauthorized"
  /** The person blocked the bot or the chat is gone: nothing more goes there. */
  | "blocked"
  /** The message (to change) or file isn't there. */
  | "notFound"
  /** A change that changes nothing. */
  | "notModified"
  /** The call was refused as it was made (markup the app can't read, say). */
  | "badRequest"
  | "tooLarge"
  /** Too many calls: `retryAfterMs` says how long to wait. */
  | "rateLimited"
  /** The app didn't answer. */
  | "network"
  | "other";

/** A chat app's refusal; its message never carries a token. */
export class ChannelError extends Error {
  constructor(
    readonly channel: ChatChannel,
    readonly method: string,
    readonly kind: ChannelErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = "ChannelError";
  }
}
