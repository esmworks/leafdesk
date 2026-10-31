import { applyLiveEdit, chatFailure, MAX_AGENT_CHAT_MESSAGE, type AgentChatError, type AgentChatState, type AgentChatTurn } from "@/lib/agent-chat";
import { iconText } from "@/lib/icon-value";
import { escapeHtml, htmlToText, markdownToTelegramBlocks, packMessages } from "@/lib/telegram-format";
import { ConnectedAppReadOnlyError } from "@/server/access";
import { agentChatInfo, AgentChatRefusal, chatAgents, chatTurn, latestThreadConversation, sendAgentChat } from "@/server/agents/chat";
import { followLiveText } from "@/server/agents/live-text";
import { asWrite } from "@/server/connected-app";
import { editMessage, TelegramApiError, type InlineKeyboard } from "./api";
import { updateLink, type TelegramLinkRow } from "./links";
import { sendApprovalHere } from "./notify";
import { changeLines, html, send, sendHtml, type Translator } from "./say";

/**
 * Chatting with an agent from Telegram: with /agent the person picks one of the workspace's agents
 * shared with them (agents/chat.ts chatAgents), and their messages go to it instead of the AI chat,
 * each one a run of the agent's own chat with them (the one its page shows, so the conversation goes
 * on in the app), sent as a connected app's write: a workspace that lets apps only read takes none,
 * and the run gets no mail tools (lib/agents.ts mailRun). /new starts a new conversation there.
 *
 * The answer is followed as the agent writes it, in one message edited every few seconds
 * (live-text.ts), then put there formatted, with the pages it changed. A call it waits on comes as
 * the inbox's approval message (notify.ts) when this person answers it: from deliverTelegram when
 * their notifications come here, else sent here; the chat keeps following, for as long as the call
 * may wait. /stop stops following; the agent finishes and its answer shows on its page.
 */

/** How often the run is looked at while it works, and while it waits on a call. */
const POLL_MS = 2_000;
const WAITING_POLL_MS = 10_000;
/** How long a run is followed: a day for a call to be answered (run.ts APPROVAL_TIMEOUT_MS), and some. */
const FOLLOW_MS = 25 * 60 * 60_000;
/** The most of the text being written that the message shows. */
const PREVIEW_CHARS = 3_500;

type Workspace = { id: string; name: string };

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

/** The agent's name as messages show it, when the person may still chat with it. */
async function agentName(link: TelegramLinkRow, workspaceId: string, agentId: string): Promise<string | null> {
  const info = await agentChatInfo(link.userId, workspaceId, agentId, null);
  return info.agent ? escapeHtml(agentLabel(info.agent)) : null;
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
  await send(link.chatId, escapeHtml(t(`agent.refused.${code === "busy" || code === "rateLimited" ? code : "invalid"}`)));
}

/**
 * Sends a message to the link's agent and follows its answer into the chat. `waiting` says when
 * the run waits on a call (no "typing…" then). Runs inside the person's connected-app call.
 */
export async function askAgent(link: TelegramLinkRow, t: Translator, workspace: Workspace, question: string, signal: AbortSignal, waiting: (on: boolean) => void) {
  const agentId = link.agentId!;
  const message = (conversationId: string | null) =>
    asWrite(() => sendAgentChat(link.userId, { workspaceId: workspace.id, agentId, place: null, conversationId, message: question }));
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
  const name = (await agentName(link, workspace.id, agentId)) ?? "";
  await follow(link, t, workspace, sent.runId, name, signal, waiting);
}

/** What the message shows of the text being written: escaped, cut short, marked as still being written. */
function previewOf(text: string): string {
  if (!text.trim()) return "";
  return `${escapeHtml(text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text)} ✍️`;
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

/** Edits a message, again as plain text when Telegram can't parse its markup; a failed edit (too many, or nothing changed) is let go. */
async function edit(chatId: string, messageId: number, text: string) {
  try {
    await editMessage(chatId, messageId, text);
  } catch (error) {
    if (!(error instanceof TelegramApiError)) throw error;
    if (error.code === 400 && !/not modified/i.test(error.message)) await editMessage(chatId, messageId, htmlToText(text), { plain: true }).catch(() => {});
  }
}

/** Follows a run of the agent's chat until it ends, its answer into the chat. */
async function follow(link: TelegramLinkRow, t: Translator, workspace: Workspace, runId: string, agent: string, signal: AbortSignal, waiting: (on: boolean) => void) {
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
  // The call (or the owner's turn) the chat last spoke of.
  let told: string | null = null;
  const until = Date.now() + FOLLOW_MS;
  try {
    while (!signal.aborted && Date.now() < until) {
      const turn = await chatTurn(link.userId, workspace.id, runId);
      if (turn.status === "done" || turn.status === "failed") return void (await finish(chatId, t, turn, previewId, shown));
      const parked = turn.status === "awaiting_approval";
      waiting(parked);
      if (!parked) told = null;
      else if (told !== (turn.pending?.callId ?? "")) {
        if (await tellWaiting(link, t, runId, turn.pending, agent)) told = turn.pending?.callId ?? "";
      }
      const now = previewOf(text);
      if (now && now !== shown) {
        if (previewId) await edit(chatId, previewId, now);
        else previewId = await send(chatId, now);
        shown = now;
      }
      await pause(parked ? WAITING_POLL_MS : POLL_MS, signal);
    }
    if (signal.aborted) await send(chatId, html(t, "agent.stopped", { agent }));
  } finally {
    following.abort();
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Says that the run waits on a call: for this person, its approval message (deliverTelegram sends
 * it when their notifications come here; else it is sent now); for an owner, that it waits on them.
 * False when the approval message isn't there yet (the run has only just stopped): asked again.
 */
async function tellWaiting(link: TelegramLinkRow, t: Translator, runId: string, pending: AgentChatTurn["pending"], agent: string): Promise<boolean> {
  if (!pending) {
    await send(link.chatId, html(t, "agent.waitingOwner", { agent }));
    return true;
  }
  if (link.notifications) {
    await send(link.chatId, html(t, "agent.waiting", { agent, connection: escapeHtml(pending.connectionName) }));
    return true;
  }
  return sendApprovalHere(link.userId, link.chatId, runId);
}

/** The run's end: its answer, formatted, in place of what was shown as it was written (and after it, when longer); or why it failed. */
async function finish(chatId: string, t: Translator, turn: AgentChatTurn, previewId: number | null, shown: string) {
  if (turn.status === "failed") {
    const note = `<i>${escapeHtml(t(`agent.failed.${chatFailure(turn.code)}`))}</i>`;
    if (previewId) return edit(chatId, previewId, `${shown.replace(/ ✍️$/, "")}\n\n${note}`);
    return void (await send(chatId, note));
  }
  const blocks = markdownToTelegramBlocks(turn.answer);
  const changes = changeLines(t, turn.steps);
  if (changes) blocks.push(changes);
  const messages = packMessages(blocks.length ? blocks : [escapeHtml(t("errors.empty"))]);
  if (!previewId) return void (await sendHtml(chatId, messages));
  await edit(chatId, previewId, messages[0]);
  if (messages.length > 1) await sendHtml(chatId, messages.slice(1));
}
