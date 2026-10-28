import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, negotiateLocale, type Locale } from "@/i18n/config";
import { telegramMessages } from "@/i18n/messages/telegram";
import { CHAT_MODES, sourceHref, type ChatActionView, type ChatMode, type ChatSourceView, type ChatStepView } from "@/lib/ai-chat";
import { MAX_REDO_NOTE } from "@/lib/connections";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { escapeHtml, htmlToText, markdownToTelegramBlocks, packMessages, preview } from "@/lib/telegram-format";
import { connectedAppHold } from "@/server/access";
import type { AiErrorCode } from "@/lib/ai";
import { isAiError, sttLimits } from "@/server/ai";
import { decideChange, type ChatDecision } from "@/server/ai-chat-approvals";
import { startChat } from "@/server/ai-chat";
import { asWrite, runAsConnectedApp } from "@/server/connected-app";
import { savedLocale } from "@/server/mail/locale";
import { transcribeDictation } from "@/server/voice-notes";
import { listWorkspaces } from "@/server/workspaces";
import {
  answerCallback,
  downloadFile,
  editButtons,
  editMessage,
  sendMessage,
  sendTyping,
  TelegramApiError,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api";
import { answerCall, answerNotification } from "./notify";
import { linkMode, linkOf, linkWithCode, setTelegramNotifications, touchLink, unlinkTelegram, updateLink, type TelegramLinkRow } from "./links";

/**
 * The Telegram bot: people who linked their Telegram account (links.ts) ask the AI chat
 * (server/ai-chat.ts) in a private chat with the bot, by text or voice message, and get its answer
 * there, with its sources as links to their pages. Each question runs as its person through
 * `runAsConnectedApp`, so the workspace's connected-apps setting holds it as it holds MCP and API
 * tokens: a workspace that turned apps off isn't offered, and one that lets them only read is
 * answered without changes. In mode `ask`, each change (and each note to remember, and each call
 * that changes something at a connection) is asked about with buttons under a message; only the
 * linked person can press them.
 *
 * One question at a time per person: another waits until the answer is in (or /stop). Commands:
 * /start (with a link code: links the account), /help, /new, /workspace, /mode, /stop,
 * /notifications, /unlink. The person's inbox notifications come to the chat too (notify.ts), with
 * buttons to mark them read or snooze them, and an agent's call waiting for an owner with buttons
 * to approve, decline or send it back with a note (written in answer to the bot's question).
 */

type Translator = ReturnType<typeof translatorFor>;

function translatorFor(locale: Locale) {
  return createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram" });
}

/** The person's language: the one they last used Leafdesk in, else their Telegram app's. */
async function localeOf(userId: string | null, languageCode?: string): Promise<Locale> {
  const saved = userId ? await savedLocale(userId).catch(() => null) : null;
  return saved ?? (languageCode ? negotiateLocale(languageCode) : DEFAULT_LOCALE);
}

/**
 * A translated text as HTML with its values put in as given HTML: the text is escaped, the values
 * aren't (escape them with escapeHtml unless they are markup).
 */
function html(t: Translator, key: Parameters<Translator>[0], values: Record<string, string> = {}): string {
  const tokens = Object.fromEntries(Object.keys(values).map((name, i) => [name, `\u0001${i}\u0001`]));
  const list = Object.values(values);
  return escapeHtml(t(key, tokens)).replace(/\u0001(\d+)\u0001/g, (_, i: string) => list[Number(i)]);
}

/** Answers that are being written, by link: /stop aborts one; a second question waits for it. */
const answering = new Map<string, AbortController>();
/** Approval messages still waiting, by approval id: their text, to keep when the buttons go. */
const asked = new Map<string, { text: string; messageId: number | null }>();

/**
 * Notes asked for to send an agent's call back (by the chat and the asking message's id): the
 * approval message they answer. The newest MAX_NOTES_ASKED are kept; a note asked for before the
 * server restarted is read as a question.
 */
const notesAsked = new Map<string, { notificationId: string; guard: string; messageId: number }>();
const MAX_NOTES_ASKED = 1_000;

/** How often "typing…" is sent again while an answer is written (Telegram shows it for 5 s). */
const TYPING_EVERY_MS = 4_500;

/** Sends HTML messages, each again as plain text when Telegram can't parse its markup. */
async function sendHtml(chatId: string, messages: string[], keyboard?: InlineKeyboard): Promise<number | null> {
  let last: number | null = null;
  for (const [i, text] of messages.entries()) {
    const options = i === messages.length - 1 && keyboard ? { keyboard } : {};
    try {
      last = await sendMessage(chatId, text, options);
    } catch (error) {
      if (!(error instanceof TelegramApiError && error.code === 400)) throw error;
      last = await sendMessage(chatId, htmlToText(text), { ...options, plain: true });
    }
  }
  return last;
}

const send = (chatId: string, text: string, keyboard?: InlineKeyboard) => sendHtml(chatId, [text], keyboard);

/** The bot's command in a message (`/new`, `/new@bot`), lower case, and what follows it. */
export function commandOf(text: string): { command: string; rest: string } | null {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { command: match[1].toLowerCase(), rest: (match[2] ?? "").trim() } : null;
}

/** Handles one update from Telegram; never throws (a failure is logged). */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (error) {
    console.error("[telegram] update failed", error instanceof TelegramApiError ? error.message : error);
  }
}

// ---------------------------------------------------------------------------------- messages

async function onMessage(message: TelegramMessage) {
  const from = message.from;
  if (!from || from.is_bot) return;
  const chatId = String(message.chat.id);
  const text = message.text ?? "";
  const command = commandOf(text);
  if (message.chat.type !== "private") {
    // Groups would let others read the answers: only a command there gets an answer, this one.
    if (command) await send(chatId, escapeHtml(translatorFor(await localeOf(null, from.language_code))("onlyPrivate")));
    return;
  }
  if (command?.command === "start" && command.rest) {
    const userId = await linkWithCode(command.rest, from, message.chat.id);
    const t = translatorFor(await localeOf(userId, from.language_code));
    if (!userId) return void (await send(chatId, escapeHtml(t("badCode"))));
    const link = await linkOf(from.id, message.chat.id);
    const workspace = link ? await currentWorkspace(link) : null;
    const name = escapeHtml([from.first_name, from.last_name].filter(Boolean).join(" "));
    await send(chatId, workspace ? html(t, "linked", { name, workspace: escapeHtml(workspace.name) }) : html(t, "linkedNoWorkspace", { name }));
    return;
  }
  const link = await linkOf(from.id, message.chat.id);
  const t = translatorFor(await localeOf(link?.userId ?? null, from.language_code));
  if (!link) return void (await send(chatId, escapeHtml(t("notLinked"))));
  void touchLink(link.id).catch(() => {});
  const replyTo = message.reply_to_message ? `${chatId}:${message.reply_to_message.message_id}` : null;
  const asked = replyTo ? notesAsked.get(replyTo) : undefined;
  if (asked && replyTo && !command) {
    notesAsked.delete(replyTo);
    const outcome = await answerCall(link.userId, asked.notificationId, asked.guard, "redo", text.slice(0, MAX_REDO_NOTE));
    // An empty note can be written again in answer to the same question.
    if (outcome === "emptyNote") notesAsked.set(replyTo, asked);
    else await editButtons(chatId, asked.messageId).catch(() => {});
    return void (await sendMessage(chatId, escapeHtml(t(`notify.call.${outcome}`)), { replyTo: asked.messageId }));
  }
  if (command) return onCommand(link, t, command.command);
  const voice = message.voice ?? message.audio;
  const question = (text || message.caption || "").trim();
  if (!question && !voice) return void (await send(chatId, escapeHtml(t("onlyText"))));
  if (answering.has(link.id)) return void (await send(chatId, escapeHtml(t("busy"))));
  const controller = new AbortController();
  answering.set(link.id, controller);
  try {
    await runAsConnectedApp({ userId: link.userId }, () => ask(link, t, question, voice ?? null, controller.signal));
  } finally {
    answering.delete(link.id);
  }
}

async function onCommand(link: TelegramLinkRow, t: Translator, command: string) {
  const chatId = link.chatId;
  if (command === "start" || command === "help") return void (await send(chatId, escapeHtml(t("help"))));
  if (command === "stop") {
    const running = answering.get(link.id);
    running?.abort();
    return void (await send(chatId, escapeHtml(t(running ? "stopped" : "nothingToStop"))));
  }
  if (command === "unlink") {
    answering.get(link.id)?.abort();
    await unlinkTelegram(link.userId);
    return void (await send(chatId, escapeHtml(t("unlinked"))));
  }
  if (command === "new") {
    await updateLink(link.id, { conversationId: null });
    const workspace = await runAsConnectedApp({ userId: link.userId }, () => currentWorkspace(link));
    return void (await send(chatId, workspace ? html(t, "newConversation", { workspace: escapeHtml(workspace.name) }) : escapeHtml(t("noWorkspace"))));
  }
  if (command === "workspace") {
    const [workspaces, current] = await runAsConnectedApp({ userId: link.userId }, () => Promise.all([listWorkspaces(link.userId), currentWorkspace(link)]));
    if (!workspaces.length) return void (await send(chatId, escapeHtml(t("noWorkspace"))));
    const keyboard = { inline_keyboard: workspaces.slice(0, 50).map((w) => [{ text: `${w.id === current?.id ? "✓ " : ""}${w.icon && !w.icon.includes("/") ? `${w.icon} ` : ""}${w.name}`, callback_data: `ws:${w.id}` }]) };
    return void (await send(chatId, current ? html(t, "pickWorkspace", { workspace: escapeHtml(current.name) }) : escapeHtml(t("pickWorkspaceNone")), keyboard));
  }
  if (command === "notifications") {
    const on = link.notifications;
    const keyboard = { inline_keyboard: [[{ text: t(on ? "notifications.turnOff" : "notifications.turnOn"), callback_data: `nt:${on ? "off" : "on"}` }]] };
    return void (await send(chatId, escapeHtml(t(on ? "notifications.on" : "notifications.off")), keyboard));
  }
  if (command === "mode") {
    const mode = linkMode(link.mode);
    const keyboard = { inline_keyboard: CHAT_MODES.map((m) => [{ text: `${m === mode ? "✓ " : ""}${t(`modes.${m}`)}`, callback_data: `md:${m}` }]) };
    return void (await send(chatId, html(t, "pickMode", { mode: escapeHtml(t(`modes.${mode}`)) }), keyboard));
  }
  await send(chatId, escapeHtml(t("help")));
}

/**
 * The workspace the link's questions go to: its own while the person is in it and apps may reach
 * it, else their first such workspace (kept on the link, with a new conversation); null when there
 * is none. Runs inside the person's connected-app call.
 */
async function currentWorkspace(link: TelegramLinkRow): Promise<{ id: string; name: string } | null> {
  const workspaces = await listWorkspaces(link.userId);
  const found = workspaces.find((w) => w.id === link.workspaceId) ?? workspaces[0];
  if (!found) return null;
  if (found.id !== link.workspaceId) {
    await updateLink(link.id, { workspaceId: found.id, conversationId: null });
    link.workspaceId = found.id;
    link.conversationId = null;
  }
  return { id: found.id, name: found.name };
}

// ---------------------------------------------------------------------------------- questions

/** Writes down a voice message; its text, or null when the person was told why not. */
async function heard(link: TelegramLinkRow, t: Translator, workspaceId: string, voice: NonNullable<TelegramMessage["voice"]>, signal: AbortSignal): Promise<string | null> {
  const limits = sttLimits();
  if (!limits) {
    await send(link.chatId, escapeHtml(t("voiceOff")));
    return null;
  }
  if (voice.duration > limits.maxSeconds) {
    await send(link.chatId, escapeHtml(t("voiceTooLong", { minutes: Math.max(1, Math.floor(limits.maxSeconds / 60)) })));
    return null;
  }
  try {
    const bytes = await downloadFile(voice.file_id, limits.maxBytes, signal);
    const text = await transcribeDictation(link.userId, workspaceId, { bytes, type: voice.mime_type || "audio/ogg" }, { signal });
    await send(link.chatId, text ? html(t, "heard", { text: `<i>${escapeHtml(text)}</i>` }) : escapeHtml(t("voiceFailed")));
    return text || null;
  } catch (error) {
    if (signal.aborted) return null;
    if (isAiError(error) && error.code === "disabled") await send(link.chatId, escapeHtml(t("voiceOff")));
    else {
      if (!isAiError(error) && !(error instanceof TelegramApiError)) console.error("[telegram] voice message failed", error);
      await send(link.chatId, escapeHtml(t("voiceFailed")));
    }
    return null;
  }
}

/** Asks the AI chat a question for the link's person and sends its answer to the chat. */
async function ask(link: TelegramLinkRow, t: Translator, text: string, voice: TelegramMessage["voice"] | null, signal: AbortSignal) {
  const chatId = link.chatId;
  const workspace = await currentWorkspace(link);
  if (!workspace) return void (await send(chatId, escapeHtml(t("noWorkspace"))));

  // "typing…" while the answer is written, not while it waits for the person.
  let waiting = false;
  const typing = () => void (!waiting && sendTyping(chatId).catch(() => {}));
  typing();
  const timer = setInterval(typing, TYPING_EVERY_MS);
  const approvals: string[] = [];
  try {
    const question = text || (voice ? await heard(link, t, workspace.id, voice, signal) : null);
    if (!question) return;
    const mode = linkMode(link.mode);
    const readOnly = mode !== "read" && (await asWrite(() => connectedAppHold(link.userId, workspace.id))) === "readOnly";
    if (readOnly) await send(chatId, html(t, "readOnlyWorkspace", { workspace: escapeHtml(workspace.name) }));

    const start = (conversationId: string | null) => startChat(link.userId, { workspaceId: workspace.id, conversationId, message: question, mode }, signal);
    let events;
    try {
      events = await start(link.conversationId);
    } catch (error) {
      // The conversation was deleted (or pruned) in the meantime: a new one.
      if (!(isAiError(error) && error.code === "noAccess" && link.conversationId)) throw error;
      await updateLink(link.id, { conversationId: null });
      events = await start(null);
    }

    let answer = "";
    let sources: ChatSourceView[] = [];
    const steps: ChatStepView[] = [];
    let ending: { stopReason?: "stop" | "length"; error?: AiErrorCode } = {};
    for await (const event of events) {
      // An approval holds the answer until the person decides; pings come meanwhile.
      if (event.type !== "ping") waiting = event.type === "approval";
      if (event.type === "conversation" && event.id !== link.conversationId) {
        link.conversationId = event.id;
        await updateLink(link.id, { conversationId: event.id });
      } else if (event.type === "text") answer += event.text;
      else if (event.type === "reset") answer = "";
      else if (event.type === "step") steps.push(event.step);
      else if (event.type === "approval") {
        approvals.push(event.id);
        await askApproval(link, t, event.id, event.action, mode);
      }
      else if (event.type === "sources") sources = event.sources;
      else if (event.type === "done") ending = { stopReason: event.stopReason };
      else if (event.type === "error") ending = { error: event.code };
    }
    waiting = false;
    if (ending.error === "aborted" && !answer.trim()) return;
    if (ending.error && !answer.trim()) return void (await send(chatId, escapeHtml(t(`errors.${ending.error}`))));
    await sendHtml(chatId, answerMessages(t, answer, sources, steps, ending));
  } catch (error) {
    if (isAiError(error)) {
      if (error.code !== "aborted") await send(chatId, escapeHtml(t(`errors.${error.code}`)));
      return;
    }
    throw error;
  } finally {
    clearInterval(timer);
    await closeApprovals(t, chatId, approvals);
  }
}

/** The answer as messages: its text, the changes it made, its sources and a note when cut short. */
function answerMessages(t: Translator, answer: string, sources: ChatSourceView[], steps: ChatStepView[], ending: { stopReason?: "stop" | "length"; error?: AiErrorCode }): string[] {
  const pageUrl = (source: Pick<ChatSourceView, "workspaceId" | "pageId" | "blockId">) => {
    const href = sourceHref(source);
    return href ? `${env.appUrl}${href}` : null;
  };
  const cite = (n: number) => {
    const source = sources.find((s) => s.n === n);
    return source ? pageUrl(source) : null;
  };
  const blocks = markdownToTelegramBlocks(answer, cite);
  const changes = steps.flatMap((step) => {
    if (step.kind !== "write") return [];
    // A link only to the row or page made or changed: a declined new one has none.
    const page = step.page ?? (step.action === "updateRow" || step.action === "editPage" ? step.target : null);
    const title = escapeHtml(pageLabel(step.title ?? page?.title ?? "", t("approval.aPage")));
    const href = page ? pageUrl({ workspaceId: page.workspaceId, pageId: page.pageId, blockId: null }) : null;
    return [html(t, `changed.${step.outcome}`, { what: href ? `<a href="${escapeHtml(href)}">${title}</a>` : title })];
  });
  if (changes.length) blocks.push(changes.join("\n"));
  if (sources.length) {
    const lines = sources.map((s) => {
      const href = pageUrl(s);
      const title = s.title === null ? escapeHtml(t("sourceGone")) : escapeHtml(pageLabel(s.title, t("approval.aPage")));
      return `[${s.n}] ${href ? `<a href="${escapeHtml(href)}">${title}</a>` : title}`;
    });
    blocks.push(`<b>${escapeHtml(t("sources"))}</b>\n${lines.join("\n")}`);
  }
  if (ending.stopReason === "length") blocks.push(`<i>${escapeHtml(t("cutOff"))}</i>`);
  else if (ending.error === "aborted") blocks.push(`<i>${escapeHtml(t("stoppedNote"))}</i>`);
  else if (ending.error) blocks.push(`<i>${escapeHtml(t(`errors.${ending.error}`))}</i>`);
  return packMessages(blocks);
}

// ---------------------------------------------------------------------------------- approvals

/** What a change the chat asks about does, as a message: what, where, and what it sets or sends. */
export function approvalText(t: Translator, action: ChatActionView): string {
  const name = (title: string | null | undefined) => `<b>${escapeHtml(pageLabel(title ?? "", t("approval.aPage")))}</b>`;
  const lines: string[] = [];
  if (action.action === "connection") {
    lines.push(html(t, "approval.connection", { connection: escapeHtml(action.connection?.name ?? ""), tool: escapeHtml(action.title ?? "") }));
  } else if (action.action === "tool") {
    lines.push(html(t, "approval.tool", { tool: escapeHtml(action.title ?? "") }));
  } else if (action.action === "remember" || action.action === "forget") {
    lines.push(escapeHtml(t(`approval.${action.action}`)), `<blockquote>${escapeHtml(action.title ?? "")}</blockquote>`);
  } else if (action.action === "readWeb" || action.action === "searchWeb") {
    // The address or the words, whole, as they would leave the workspace.
    lines.push(escapeHtml(t(`approval.${action.action}`)), `<pre>${escapeHtml(action.title ?? "")}</pre>`);
  } else if (action.action === "createPage" && !action.target) {
    lines.push(html(t, "approval.createPageTop", { title: name(action.title) }));
  } else if (action.action === "createDatabase" && !action.target) {
    lines.push(html(t, "approval.createDatabaseTop", { title: name(action.title) }));
  } else {
    lines.push(html(t, `approval.${action.action}`, { title: name(action.title), target: name(action.target?.title) }));
  }
  if (action.publicForm) lines.push(escapeHtml(t(`approval.publicForm.${action.publicForm}`)));
  for (const change of action.changes.slice(0, 20)) {
    const value = preview(change.value, 200);
    const before = change.before !== undefined ? `${escapeHtml(preview(change.before, 100))} → ` : "";
    lines.push(`• ${escapeHtml(change.property)}: ${before}${escapeHtml(value)}`);
  }
  if (action.content) {
    const content = preview(action.content, 1_000);
    lines.push(action.action === "connection" || action.action === "tool" ? `<pre>${escapeHtml(action.content.slice(0, 1_500))}</pre>` : `<blockquote>${escapeHtml(content)}</blockquote>`);
  }
  return lines.join("\n");
}

async function askApproval(link: TelegramLinkRow, t: Translator, id: string, action: ChatActionView, mode: ChatMode) {
  const text = approvalText(t, action);
  // "Don't ask again" makes the rest of the answer `auto`, which covers changes to the workspace only.
  const always = mode === "ask" && !action.eachTime && !["connection", "remember", "forget", "readWeb", "searchWeb"].includes(action.action);
  const keyboard = {
    inline_keyboard: [
      [
        { text: t("approval.yes"), callback_data: `ap:${id}:y` },
        { text: t("approval.no"), callback_data: `ap:${id}:n` },
      ],
      ...(always ? [[{ text: t("approval.always"), callback_data: `ap:${id}:a` }]] : []),
    ],
  };
  asked.set(id, { text, messageId: null });
  const messageId = await send(link.chatId, text, keyboard);
  const entry = asked.get(id);
  if (entry) entry.messageId = messageId;
}

/** Takes the buttons off approvals of an answer that ended without the person deciding them. */
async function closeApprovals(t: Translator, chatId: string, ids: string[]) {
  for (const id of ids) {
    const entry = asked.get(id);
    asked.delete(id);
    if (entry?.messageId) await editMessage(chatId, entry.messageId, `${entry.text}\n\n<i>${escapeHtml(t("approval.gone"))}</i>`).catch(() => {});
  }
}

const DECISIONS: Record<string, ChatDecision> = { y: "approve", a: "always", n: "decline" };

async function onCallback(query: TelegramCallbackQuery) {
  const message = query.message;
  const data = query.data ?? "";
  if (!message) return void (await answerCallback(query.id));
  const link = await linkOf(query.from.id, message.chat.id);
  const t = translatorFor(await localeOf(link?.userId ?? null, query.from.language_code));
  if (!link) return void (await answerCallback(query.id, t("notLinked")));
  const chatId = link.chatId;

  const approval = /^ap:([\w-]{1,60}):([yan])$/.exec(data);
  if (approval) {
    const [, id, choice] = approval;
    const decision = DECISIONS[choice];
    const text = asked.get(id)?.text ?? escapeHtml(message.text ?? "");
    asked.delete(id);
    if (!decideChange(link.userId, id, decision)) {
      await answerCallback(query.id, t("approval.gone"));
      await editMessage(chatId, message.message_id, text).catch(() => {});
      return;
    }
    await answerCallback(query.id);
    const outcome = decision === "decline" ? t("approval.declined") : t("approval.approved");
    await editMessage(chatId, message.message_id, `${text}\n\n<i>${escapeHtml(outcome)}</i>`).catch(() => {});
    return;
  }

  const workspace = /^ws:([\w-]{1,60})$/.exec(data);
  if (workspace) {
    const found = (await runAsConnectedApp({ userId: link.userId }, () => listWorkspaces(link.userId))).find((w) => w.id === workspace[1]);
    await answerCallback(query.id);
    if (!found) return void (await editMessage(chatId, message.message_id, escapeHtml(t("noWorkspace"))).catch(() => {}));
    await updateLink(link.id, { workspaceId: found.id, conversationId: null });
    await editMessage(chatId, message.message_id, html(t, "workspaceSet", { workspace: escapeHtml(found.name) })).catch(() => {});
    return;
  }

  const notifications = /^nt:(on|off)$/.exec(data);
  if (notifications) {
    const on = notifications[1] === "on";
    await setTelegramNotifications(link.userId, on);
    await answerCallback(query.id);
    await editMessage(chatId, message.message_id, escapeHtml(t(on ? "notifications.on" : "notifications.off"))).catch(() => {});
    return;
  }

  const call = /^a([adr]):([\w-]{1,60}):([0-9a-f]{10})$/.exec(data);
  if (call) {
    const [, choice, notificationId, guard] = call;
    await answerCallback(query.id);
    if (choice === "r") {
      const asking = await sendMessage(chatId, escapeHtml(t("notify.notePrompt")), { forceReply: t("notify.notePlaceholder"), replyTo: message.message_id });
      notesAsked.set(`${chatId}:${asking}`, { notificationId, guard, messageId: message.message_id });
      if (notesAsked.size > MAX_NOTES_ASKED) notesAsked.delete(notesAsked.keys().next().value!);
      return;
    }
    const outcome = await answerCall(link.userId, notificationId, guard, choice === "a" ? "approve" : "decline");
    await editButtons(chatId, message.message_id).catch(() => {});
    await sendMessage(chatId, escapeHtml(t(`notify.call.${outcome}`)), { replyTo: message.message_id });
    return;
  }

  const answered = /^n([rz]):([\w-]{1,60})$/.exec(data);
  if (answered) {
    const action = answered[1] === "r" ? "read" : "snooze";
    const done = await answerNotification(link.userId, answered[2], action);
    await answerCallback(query.id, t(done ? (action === "read" ? "notify.read" : "notify.snoozed") : "notify.gone"));
    await editButtons(chatId, message.message_id).catch(() => {});
    return;
  }

  const mode = /^md:(\w+)$/.exec(data);
  if (mode && (CHAT_MODES as readonly string[]).includes(mode[1])) {
    const chosen = mode[1] as ChatMode;
    await updateLink(link.id, { mode: chosen });
    await answerCallback(query.id);
    await editMessage(chatId, message.message_id, html(t, "modeSet", { mode: escapeHtml(t(`modes.${chosen}`)) })).catch(() => {});
    return;
  }
  await answerCallback(query.id);
}
