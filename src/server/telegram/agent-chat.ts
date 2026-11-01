import { applyLiveEdit, chatFailure, MAX_AGENT_CHAT_MESSAGE, type AgentChatError, type AgentChatState, type AgentChatTurn } from "@/lib/agent-chat";
import { AGENT_CHAT_FILE_LIMITS } from "@/lib/agent-chat-files";
import { MAX_QUEUED } from "@/lib/agent-chat-queue";
import { formatBytes } from "@/lib/files";
import { iconText } from "@/lib/icon-value";
import { escapeHtml, htmlToText, markdownToTelegramBlocks, packMessages } from "@/lib/telegram-format";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import {
  agentChatInfo,
  AgentChatRefusal,
  chatAgents,
  chatRunState,
  chatTurn,
  latestThreadConversation,
  nextQueuedRun,
  sendAgentChat,
  summarizeAgentConversation,
} from "@/server/agents/chat";
import { chatFileOfPerson } from "@/server/agents/chat-files";
import { followLiveText } from "@/server/agents/live-text";
import { asWrite, runAsConnectedApp } from "@/server/connected-app";
import { refOf, storageOf } from "@/server/storage/workspace";
import { editMessage, sendDocument, TelegramApiError, type InlineKeyboard } from "./api";
import { telegramNotificationsOn, updateLink, type TelegramLinkRow } from "./links";
import { sendApprovalHere } from "./notify";
import { changeLines, html, send, sendHtml, type Translator } from "./say";

/**
 * Chatting with an agent from Telegram: with /agent the person picks one of the workspace's agents
 * shared with them (agents/chat.ts chatAgents), and their messages go to it instead of the AI chat,
 * each one a run of the agent's own chat with them (the one its page shows, so the conversation goes
 * on in the app), sent as a connected app's write: a workspace that lets apps only read takes none,
 * and the run gets no mail tools (lib/agents.ts mailRun). /new starts a new conversation there,
 * `/new summary` one that starts from a summary of the last. A text file sent as a document goes
 * with its caption; a message sent while the agent answers waits in the conversation's queue and
 * goes as its next turn, which the follow then goes on to.
 *
 * The answer is followed as the agent writes it, in one message edited every few seconds
 * (live-text.ts), then put there formatted, with the pages it changed. A call it waits on comes as
 * the inbox's approval message (notify.ts) when this person answers it: from deliverTelegram when
 * their notifications come here, else sent here; the chat keeps following, for as long as the call
 * may wait, but takes other messages meanwhile (`release`). /stop stops following; the agent
 * finishes and its answer shows on its page, as when the follow can't go on (access lost, the
 * server restarting). Files the agent attached to its answer come after it, as documents.
 */

/** How often the run is looked at while it works, and while it waits on a call. */
const POLL_MS = 2_000;
const WAITING_POLL_MS = 10_000;
/** How long a run is followed: a day for a call to be answered (run.ts APPROVAL_TIMEOUT_MS), and some. */
const FOLLOW_MS = 25 * 60 * 60_000;
/** The most of the text being written that the message shows. */
const PREVIEW_CHARS = 3_500;
/** Looks at the run that fail in a row (the database out of reach) before the follow gives up. */
const MAX_FAILED_LOOKS = 5;
/** Tries to send the approval message here before saying where to answer the call instead. */
const APPROVAL_TRIES = 2;
/** The longest wait Telegram may ask for before the answer is sent again. */
const MAX_RETRY_MS = 60_000;

type Workspace = { id: string; name: string };

/** What the bot does around a followed answer: "typing…" off while the run waits, and the chat freed for other messages. */
export type FollowHooks = { waiting: (on: boolean) => void; release: () => void };

const agentLabel = (agent: { name: string; icon: string | null }) => {
  const icon = iconText(agent.icon);
  return `${icon && !icon.includes("/") ? `${icon} ` : ""}${agent.name}`;
};

/** /agent: the agents the person may chat with, with the AI chat first; ✓ marks where messages go now. */
export async function agentPicker(link: TelegramLinkRow, t: Translator, workspace: Workspace): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const agents = await chatAgents(link.userId, workspace.id);
  if (!agents.length) return { text: html(t, "agent.none", { workspace: escapeHtml(workspace.name) }) };
  const current = agents.find((a) => a.id === link.agentId) ?? null;
  const keyboard = {
    inline_keyboard: [
      [{ text: `${current ? "" : "✓ "}${t("agent.general")}`, callback_data: "ag:-" }],
      ...agents.slice(0, 49).map((a) => [{ text: `${a.id === current?.id ? "✓ " : ""}${agentLabel(a)}`, callback_data: `ag:${a.id}` }]),
    ],
  };
  const text = current
    ? html(t, "agent.pick", { agent: `<b>${escapeHtml(agentLabel(current))}</b>` })
    : html(t, "agent.pickNone", { workspace: escapeHtml(workspace.name) });
  return { text, keyboard };
}

/**
 * A pick from /agent's buttons: an agent the person may chat with now (its own chat with them
 * goes on, joining their latest conversation there), or back to the AI chat (null). What to say.
 */
export async function pickAgent(link: TelegramLinkRow, t: Translator, workspace: Workspace, agentId: string | null): Promise<string> {
  if (!agentId) {
    await updateLink(link.id, { agentId: null, agentConversationId: null });
    return html(t, "agent.generalSet", { workspace: escapeHtml(workspace.name) });
  }
  const info = await agentChatInfo(link.userId, workspace.id, agentId, null);
  if (!info.agent || (info.state !== "full" && info.state !== "readOnly")) return unavailable(link, t, info.state === "full" || info.state === "readOnly" ? "gone" : info.state);
  await updateLink(link.id, { agentId: info.agent.id, agentConversationId: await latestThreadConversation(link.userId, info.agent.id) });
  return html(t, info.state === "readOnly" ? "agent.setReadOnly" : "agent.set", { agent: `<b>${escapeHtml(agentLabel(info.agent))}</b>` });
}

type Unavailable = Exclude<AgentChatState, "full" | "readOnly">;

/** Why the person can't chat with an agent now, as said; one gone from them goes from the link too (messages go to the AI chat again). */
async function unavailable(link: TelegramLinkRow, t: Translator, state: Unavailable): Promise<string> {
  if (state === "gone" || state === "noAccess" || state === "guest") await updateLink(link.id, { agentId: null, agentConversationId: null });
  return escapeHtml(t(`agent.states.${state}`));
}

/** Why a message wasn't taken, said. */
async function refused(link: TelegramLinkRow, t: Translator, code: AgentChatError) {
  if (code === "gone" || code === "noAccess" || code === "guest" || code === "paused" || code === "aiOff" || code === "limitReached") {
    return void (await send(link.chatId, await unavailable(link, t, code)));
  }
  if (code === "tooLong") return void (await send(link.chatId, escapeHtml(t("agent.refused.tooLong", { max: MAX_AGENT_CHAT_MESSAGE }))));
  if (code === "queueFull") return void (await send(link.chatId, escapeHtml(t("agent.refused.queueFull", { max: MAX_QUEUED }))));
  if (code === "badFile") return void (await send(link.chatId, escapeHtml(t("agent.refused.badFile", { size: formatBytes(AGENT_CHAT_FILE_LIMITS.bytes) }))));
  await send(link.chatId, escapeHtml(t(`agent.refused.${code === "busy" || code === "rateLimited" || code === "summaryFailed" ? code : "invalid"}`)));
}

/**
 * Sends a message (and the text file it carries) to the link's agent and follows its answer into
 * the chat, then the turns that queued messages from here start after it. A message sent while the
 * agent answers is only queued: said so, the follow under way takes its answer. Runs inside the
 * person's connected-app call.
 */
export async function askAgent(
  link: TelegramLinkRow,
  t: Translator,
  workspace: Workspace,
  question: string,
  files: { name: string; text: string }[],
  signal: AbortSignal,
  hooks: FollowHooks,
) {
  const agentId = link.agentId!;
  const message = (conversationId: string | null) =>
    asWrite(() => sendAgentChat(link.userId, { workspaceId: workspace.id, agentId, place: null, conversationId, message: question, files, via: "telegram" }));
  let sent;
  try {
    try {
      sent = await message(link.agentConversationId);
    } catch (error) {
      // The conversation was deleted (or pruned) in the meantime: a new one.
      if (!(error instanceof AgentChatRefusal && error.code === "noAccess" && link.agentConversationId)) throw error;
      sent = await message(null);
    }
  } catch (error) {
    if (error instanceof ConnectedAppReadOnlyError) return void (await send(link.chatId, html(t, "agent.readOnlyWorkspace", { workspace: escapeHtml(workspace.name) })));
    if (error instanceof AgentChatRefusal) return refused(link, t, error.code);
    throw error;
  }
  if (sent.conversation.id !== link.agentConversationId) {
    link.agentConversationId = sent.conversation.id;
    await updateLink(link.id, { agentConversationId: sent.conversation.id });
  }
  if (!sent.runId) return void (await send(link.chatId, escapeHtml(t("agent.queued"))));
  const agent = escapeHtml(agentLabel(sent.agent));
  for (let runId: string | null = sent.runId; runId && !signal.aborted; ) runId = await follow(link, t, workspace, runId, agent, signal, hooks);
}

/**
 * `/new summary`: a new conversation with the link's agent that starts from a summary of the one
 * going on (agents/chat.ts summarizeAgentConversation); the summary, said. Runs inside the
 * person's connected-app call.
 */
export async function newAgentConversationFromSummary(link: TelegramLinkRow, t: Translator, workspace: Workspace) {
  if (!link.agentId || !link.agentConversationId) return void (await send(link.chatId, escapeHtml(t("agent.nothingToSummarize"))));
  let made;
  try {
    made = await asWrite(() =>
      summarizeAgentConversation(link.userId, { workspaceId: workspace.id, agentId: link.agentId!, place: null, conversationId: link.agentConversationId! }),
    );
  } catch (error) {
    if (error instanceof ConnectedAppReadOnlyError) return void (await send(link.chatId, html(t, "agent.readOnlyWorkspace", { workspace: escapeHtml(workspace.name) })));
    if (error instanceof AgentChatRefusal) {
      if (error.code === "invalid" || (error.code === "noAccess" && link.agentConversationId)) return void (await send(link.chatId, escapeHtml(t("agent.nothingToSummarize"))));
      return refused(link, t, error.code);
    }
    throw error;
  }
  link.agentConversationId = made.conversation.id;
  await updateLink(link.id, { agentConversationId: made.conversation.id });
  await sendPatiently(link.chatId, packMessages([escapeHtml(t("agent.newSummary")), ...markdownToTelegramBlocks(made.summary)]));
}

/** What the message shows of the text being written: escaped, cut short (never inside a character), marked as still being written. */
function previewOf(text: string): string {
  if (!text.trim()) return "";
  if (text.length <= PREVIEW_CHARS) return `${escapeHtml(text)} ✍️`;
  // A cut between the two halves of a surrogate pair leaves a string Telegram refuses.
  const end = /[\uD800-\uDBFF]/.test(text[PREVIEW_CHARS - 1]) ? PREVIEW_CHARS - 1 : PREVIEW_CHARS;
  return `${escapeHtml(`${text.slice(0, end)}…`)} ✍️`;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/**
 * Edits a message, again as plain text when Telegram can't parse its markup. False when it wasn't
 * edited (too many edits, the message gone): the preview is let go, the answer sent anew.
 */
async function edit(chatId: string, messageId: number, text: string): Promise<boolean> {
  try {
    await editMessage(chatId, messageId, text);
    return true;
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error;
    if (/not modified/i.test(error.message)) return true;
    if (error.code !== 400) return false;
    return editMessage(chatId, messageId, htmlToText(text), { plain: true }).then(
      () => true,
      () => false,
    );
  }
}

/** Sends the answer, once more after the wait Telegram asks for when it says too many messages went. */
async function sendPatiently(chatId: string, messages: string[]) {
  try {
    await sendHtml(chatId, messages);
  } catch (error) {
    if (!(error instanceof TelegramApiError && error.code === 429)) throw error;
    await new Promise((resolve) => setTimeout(resolve, Math.min(MAX_RETRY_MS, (error.retryAfter ?? 1) * 1000)));
    await sendHtml(chatId, messages);
  }
}

/**
 * Follows a run of the agent's chat until it ends, its answer into the chat. The run's status is
 * read cheaply each time (chatRunState); its whole turn, with access checked again, only when it
 * ends or waits on another call. A follow that ends otherwise (stopped, access lost, the database
 * out of reach, a day gone) says the answer will be on the agent's page. Once it ended: the run
 * that took the messages queued meanwhile, when one of them came from here, to follow next.
 */
async function follow(link: TelegramLinkRow, t: Translator, workspace: Workspace, runId: string, agent: string, signal: AbortSignal, hooks: FollowHooks): Promise<string | null> {
  const chatId = link.chatId;
  const following = new AbortController();
  const stop = () => following.abort();
  signal.addEventListener("abort", stop);
  // The text so far, from the agents' worker in this process; followed again when a follow runs out.
  let text = "";
  void (async () => {
    while (!following.signal.aborted) {
      try {
        for await (const change of followLiveText(runId, following.signal)) text = applyLiveEdit(text, change);
      } catch {
        await pause(POLL_MS, following.signal);
      }
    }
  })();
  let previewId: number | null = null;
  let shown = "";
  // The call the chat last spoke of (or the owner's turn, ""), and the tries at its approval message.
  let told: string | null = null;
  let tries = 0;
  let failed = 0;
  // Each look is a connected-app call of its own: one caches the workspace's setting, which may change in a day.
  const turnNow = () => runAsConnectedApp({ userId: link.userId }, () => chatTurn(link.userId, workspace.id, runId));
  const until = Date.now() + FOLLOW_MS;
  try {
    while (!signal.aborted && Date.now() < until) {
      let parked = false;
      let ended: AgentChatTurn | null = null;
      try {
        const state = await chatRunState(link.userId, runId);
        if (!state) break;
        if (state.status === "done" || state.status === "failed") ended = await turnNow();
        parked = state.status === "awaiting_approval";
        hooks.waiting(parked);
        // A call held for the agent's quiet hours is told of apart from the same call asked about once they end.
        const waitingOn = `${state.callId ?? ""}${state.deferred ? ":deferred" : ""}`;
        if (!parked) told = null;
        else if (told !== waitingOn) {
          if (told === null) hooks.release();
          if (state.deferred) {
            await send(chatId, html(t, "agent.deferred", { agent }));
            told = waitingOn;
            tries = 0;
          } else {
            const turn = await turnNow();
            if (await tellWaiting(link, t, runId, turn.pending, agent, ++tries)) {
              told = turn.pending?.callId ?? "";
              tries = 0;
            }
          }
        }
        failed = 0;
      } catch (error) {
        // Access gone (removed, apps turned off, the run no longer theirs): the follow ends; else tried again a few times.
        if (error instanceof AccessError || error instanceof AgentChatRefusal || ++failed >= MAX_FAILED_LOOKS) {
          if (!(error instanceof AccessError || error instanceof AgentChatRefusal)) console.error("[telegram] couldn't follow an agent's answer", error);
          break;
        }
      }
      // Outside the looks above: an answer that fails to go isn't sent again.
      if (ended) {
        await finish(link, t, ended, previewId, shown);
        const next = await nextQueuedRun(link.userId, runId).catch(() => null);
        return next?.telegram ? next.id : null;
      }
      const now = previewOf(text);
      if (now && now !== shown) {
        if (previewId) await edit(chatId, previewId, now);
        else previewId = await send(chatId, now).catch(() => null);
        shown = now;
      }
      await pause(parked ? WAITING_POLL_MS : POLL_MS, signal);
    }
    await send(chatId, html(t, "agent.stopped", { agent }));
    return null;
  } finally {
    following.abort();
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Says that the run waits on a call: for this person, its approval message (deliverTelegram sends
 * it when their notifications come here now; else it is sent now); for an owner, that it waits on
 * them. False when the approval message isn't there yet (the run has only just stopped): asked
 * again, and after a few tries the chat says to answer it in Leafdesk.
 */
async function tellWaiting(link: TelegramLinkRow, t: Translator, runId: string, pending: AgentChatTurn["pending"], agent: string, tries: number): Promise<boolean> {
  if (!pending) {
    await send(link.chatId, html(t, "agent.waitingOwner", { agent }));
    return true;
  }
  const connection = escapeHtml(pending.connectionName);
  if (await telegramNotificationsOn(link.userId)) {
    await send(link.chatId, html(t, "agent.waiting", { agent, connection }));
    return true;
  }
  if (await runAsConnectedApp({ userId: link.userId }, () => sendApprovalHere(link.userId, link.chatId, runId))) return true;
  if (tries < APPROVAL_TRIES) return false;
  await send(link.chatId, html(t, "agent.waitingApp", { agent, connection }));
  return true;
}

/** The run's end: its answer, formatted, in place of what was shown as it was written (or anew when that can't be edited), and the files it attached; or why it failed. */
async function finish(link: TelegramLinkRow, t: Translator, turn: AgentChatTurn, previewId: number | null, shown: string) {
  const chatId = link.chatId;
  if (turn.status === "failed") {
    const note = `<i>${escapeHtml(t(`agent.failed.${chatFailure(turn.code)}`))}</i>`;
    if (!(previewId && (await edit(chatId, previewId, `${shown.replace(/ ✍️$/, "")}\n\n${note}`)))) await sendPatiently(chatId, [note]);
    return sendFiles(link, t, turn);
  }
  const blocks = markdownToTelegramBlocks(turn.answer);
  const changes = changeLines(t, turn.steps);
  if (changes) blocks.push(changes);
  const messages = packMessages(blocks.length ? blocks : [escapeHtml(t("errors.empty"))]);
  if (previewId && (await edit(chatId, previewId, messages[0]))) {
    if (messages.length > 1) await sendPatiently(chatId, messages.slice(1));
  } else await sendPatiently(chatId, messages);
  await sendFiles(link, t, turn);
}

/** Sends the files the agent attached to its answer, each as a document; one that can't go is said to be on the agent's page. */
async function sendFiles(link: TelegramLinkRow, t: Translator, turn: AgentChatTurn) {
  for (const attached of turn.attached) {
    try {
      const found = await chatFileOfPerson(link.userId, attached.id);
      const body = found ? await (await storageOf(found)).get(refOf(found)) : null;
      if (!found || !body) throw new Error("missing");
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      await sendDocument(link.chatId, { name: found.name, contentType: found.contentType, bytes });
    } catch (error) {
      if (!(error instanceof TelegramApiError)) console.error("[telegram] couldn't send an agent's file", error instanceof Error ? error.message : error);
      await send(link.chatId, html(t, "agent.fileNotSent", { name: escapeHtml(attached.name) })).catch(() => {});
    }
  }
}
