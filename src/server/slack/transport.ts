import { htmlToMrkdwn, splitMrkdwn } from "@/lib/slack-format";
import { escapeHtml } from "@/lib/telegram-format";
import type { Buttons, Transport } from "@/server/chat-apps/transport";
import { callSlack, downloadSlackFile, uploadSlackFile } from "./api";

/**
 * Slack as a chat app of the bot (server/chat-apps): the core's HTML goes as mrkdwn in section
 * blocks (lib/slack-format.ts), its buttons as `actions` blocks whose values are the core's button
 * data; the message's `text`, which Slack's notifications show, leaves spoilers out. Slack has no
 * "typing…" for bots and no toast for a press: a notice comes as a message only the person sees
 * (chat.postEphemeral). A note asked for is written in the asking message's thread. Commands are
 * one slash command, `/leafdesk <command>` (socket.ts).
 */

/** Slack's limits: a section's text, a button's label, an actions block's elements. */
const SECTION_CHARS = 3000;
const LABEL_CHARS = 75;
const ACTIONS_PER_BLOCK = 25;

type Block = Record<string, unknown>;

/** The blocks of the bot's buttons: rows of several buttons each a block, single ones gathered into one. */
export function actionBlocks(buttons: Buttons): Block[] {
  const blocks: { type: "actions"; elements: Block[] }[] = [];
  let gathering = false;
  let n = 0;
  for (const row of buttons) {
    if (!row.length) continue;
    const elements = row.map((b) => ({
      type: "button",
      action_id: `b${n++}`,
      text: { type: "plain_text", text: b.text.slice(0, LABEL_CHARS) || "·", emoji: true },
      ...(b.url ? { url: b.url } : { value: b.data ?? "" }),
    }));
    const last = blocks.at(-1);
    if (row.length === 1 && gathering && last && last.elements.length < ACTIONS_PER_BLOCK) last.elements.push(...elements);
    else blocks.push({ type: "actions", elements });
    gathering = row.length === 1;
  }
  return blocks;
}

/** A message of the bot's as Slack's `text` and `blocks`. */
export function slackMessage(text: string, { buttons, plain }: { buttons?: Buttons; plain?: boolean } = {}) {
  const html = plain ? escapeHtml(text) : text;
  const sections = splitMrkdwn(htmlToMrkdwn(html), SECTION_CHARS).map((piece) => ({ type: "section", text: { type: "mrkdwn", text: piece } }));
  return {
    text: htmlToMrkdwn(html, { hideSpoilers: true }).slice(0, 3_900) || " ",
    blocks: [...(sections.length ? sections : [{ type: "section", text: { type: "mrkdwn", text: " " } }]), ...(buttons ? actionBlocks(buttons) : [])],
  };
}

/** The blocks of messages the bot sent or was pressed on lately, to take their buttons off without asking Slack. */
const known = new Map<string, Block[]>();
const MAX_KNOWN = 2_000;
export function remember(chat: string, ts: string, blocks: Block[]) {
  known.delete(`${chat}:${ts}`);
  known.set(`${chat}:${ts}`, blocks);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
}

async function blocksOf(chat: string, ts: string): Promise<{ text: string; blocks: Block[] } | null> {
  const cached = known.get(`${chat}:${ts}`);
  if (cached) return { text: "", blocks: cached };
  const { messages } = await callSlack<{ messages?: { ts: string; text?: string; blocks?: Block[] }[] }>("conversations.history", { channel: chat, latest: ts, inclusive: true, limit: 1 });
  const found = messages?.find((m) => m.ts === ts);
  return found ? { text: found.text ?? "", blocks: found.blocks ?? [] } : null;
}

export const slackTransport: Transport = {
  channel: "slack",
  name: "Slack",
  canEdit: true,
  canType: false,
  messageLimit: SECTION_CHARS,
  commandPrefix: "/leafdesk ",
  linkCommand: "link",

  async send(chat, text, options = {}) {
    const message = slackMessage(text, options);
    const sent = await callSlack<{ ts: string }>("chat.postMessage", {
      channel: chat,
      ...message,
      unfurl_links: false,
      unfurl_media: false,
      ...(options.replyTo ? { thread_ts: options.replyTo } : {}),
    });
    remember(chat, sent.ts, message.blocks);
    return sent.ts;
  },

  async edit(chat, messageId, text, buttons) {
    const message = slackMessage(text, { buttons });
    await callSlack("chat.update", { channel: chat, ts: messageId, ...message });
    remember(chat, messageId, message.blocks);
  },

  async editButtons(chat, messageId, buttons) {
    const found = await blocksOf(chat, messageId);
    if (!found) return;
    const blocks = [...found.blocks.filter((b) => b.type !== "actions"), ...(buttons ? actionBlocks(buttons) : [])];
    const text = found.text || blocks.flatMap((b) => (b.type === "section" ? [String((b.text as { text?: string } | undefined)?.text ?? "")] : [])).join("\n");
    await callSlack("chat.update", { channel: chat, ts: messageId, text: text.slice(0, 3_900) || " ", blocks });
    remember(chat, messageId, blocks);
  },

  async typing() {},

  async answerButton(press, notice) {
    if (notice) await callSlack("chat.postEphemeral", { channel: press.chat.id, user: press.from.id, text: escapeHtml(notice) });
  },

  async askForReply(chat, prompt, _placeholder, about) {
    // Answered in the thread of the message it is about: a reply there carries its ts.
    await callSlack("chat.postMessage", { channel: chat, ...slackMessage(prompt), thread_ts: about, unfurl_links: false, unfurl_media: false });
    return about;
  },

  downloadFile: (file, maxBytes, signal) => downloadSlackFile(file.ref, maxBytes, signal),

  async sendDocument(chat, file, caption) {
    await uploadSlackFile(chat, file, caption);
  },
};
