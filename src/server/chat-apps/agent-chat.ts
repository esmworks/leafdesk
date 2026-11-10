import { chatFailure, MAX_AGENT_CHAT_MESSAGE, type AgentChatError, type AgentChatState, type AgentChatTurn } from "@/lib/agent-chat";
import { AGENT_CHAT_FILE_LIMITS } from "@/lib/agent-chat-files";
import { livePreview } from "@/lib/agent-chat-preview";
import { MAX_QUEUED } from "@/lib/agent-chat-queue";
import { formatBytes } from "@/lib/files";
import { iconText } from "@/lib/icon-value";
import { escapeHtml, markdownToTelegramBlocks } from "@/lib/telegram-format";
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
import { followRun } from "@/server/ai-chat-runs";
import { asWrite, runAsConnectedApp } from "@/server/connected-app";
import { refOf, storageOf } from "@/server/storage/workspace";
import { linkById, updateLink, type ChatLinkRow } from "./links";
import { sendApprovalHere } from "./notify";
import { changeLines, chatOf, html, packFor, send, sendHtml, type Chat, type Translator } from "./say";
import { ChannelError, type Buttons } from "./transport";

/**
 * Chatting with an agent from a chat app: with /agent the person picks one of the workspace's agents
 * shared with them (agents/chat.ts chatAgents), and their messages go to it instead of the AI chat,
 * each one a run of the agent's own chat with them (the one its page shows, so the conversation goes
 * on in the app), sent as a connected app's write: a workspace that lets apps only read takes none,
 * and the run gets no mail tools (lib/agents.ts mailRun). Each message joins the latest conversation
 * there, as one written in the app does (wherever the last was written); /new starts a new one
 * (the link's conversation is then none until a message opens it), `/new summary` one that starts
 * from a summary of the latest. A text file sent as a document goes with its caption; a message sent
 * while the agent answers waits in the conversation's queue and goes as its next turn, which the
 * follow then goes on to. When no follow here watches the answer it waits for (one asked in the app
 * or by another app, or a follow that ended), the bot waits for that answer to end, without showing
 * it (it may draw on what this chat may not show, as email), and follows the turn that takes it.
 *
 * The answer is followed as the agent writes it, in one message edited every few seconds where the
 * chat app can change messages (else it comes once written; the
 * run's events, ai-chat-runs.ts, masked as the run keeps its answer), then put there formatted, with the pages it changed. A call it waits on comes as
 * the inbox's approval message (notify.ts) when this person answers it: from deliverChatApps when
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
/** The most the message showing the text being written holds, escaped (lib/agent-chat-preview.ts): some room under the chat app's limit. */
const previewChars = (chat: Chat) => chat.transport.messageLimit - 500;
/** Looks at the run that fail in a row (the database out of reach) before the follow gives up. */
const MAX_FAILED_LOOKS = 5;
/** Tries to send the approval message here before saying where to answer the call instead. */
const APPROVAL_TRIES = 2;
/** The longest wait the chat app may ask for before the answer is sent again. */
const MAX_RETRY_MS = 60_000;

type Workspace = { id: string; name: string };

/**
 * What the bot does around a followed answer: "typing…" off while the run waits, the chat freed for
 * other messages, and (`claim`) waiting before a new run is followed until the answer being followed
 * in the chat let go of it, so that two answers aren't written into the chat at once.
 */
export type FollowHooks = { waiting: (on: boolean) => void; release: () => void; claim: () => Promise<void> };

/** The runs a follow here (or a wait for one) is on, as `link:run`: a message queued behind one of them is taken by that follow. */
const watched = new Map<string, number>();
/** The run that took a queue to follow next: one a message from here went with, that no follow here is on yet. */
const toFollow = (link: ChatLinkRow, next: { id: string; telegram: boolean; slack: boolean } | null) =>
  next?.[link.channel] && !watched.has(`${link.id}:${next.id}`) ? next.id : null;
const watch = (linkId: string, runId: string) => {
  const key = `${linkId}:${runId}`;
  watched.set(key, (watched.get(key) ?? 0) + 1);
  return () => {
    const left = (watched.get(key) ?? 1) - 1;
    if (left > 0) watched.set(key, left);
    else watched.delete(key);
  };
};

const agentLabel = (agent: { name: string; icon: string | null }) => {
  const icon = iconText(agent.icon);
  return `${icon && !icon.includes("/") ? `${icon} ` : ""}${agent.name}`;
};

/** /agent: the agents the person may chat with, with the AI chat first; ✓ marks where messages go now. */
export async function agentPicker(link: ChatLinkRow, t: Translator, workspace: Workspace): Promise<{ text: string; buttons?: Buttons }> {
  const agents = await chatAgents(link.userId, workspace.id);
  if (!agents.length) return { text: html(t, "agent.none", { workspace: escapeHtml(workspace.name) }) };
  const current = agents.find((a) => a.id === link.agentId) ?? null;
  const buttons: Buttons = [
    [{ text: `${current ? "" : "✓ "}${t("agent.general")}`, data: "ag:-" }],
    ...agents.slice(0, 49).map((a) => [{ text: `${a.id === current?.id ? "✓ " : ""}${agentLabel(a)}`, data: `ag:${a.id}` }]),
  ];
  const text = current
    ? html(t, "agent.pick", { agent: `<b>${escapeHtml(agentLabel(current))}</b>` })
    : html(t, "agent.pickNone", { workspace: escapeHtml(workspace.name) });
  return { text, buttons };
}

/**
 * A pick from /agent's buttons: an agent the person may chat with now (its own chat with them
 * goes on, joining their latest conversation there), or back to the AI chat (null). What to say.
 */
export async function pickAgent(link: ChatLinkRow, t: Translator, workspace: Workspace, agentId: string | null): Promise<string> {
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
async function unavailable(link: ChatLinkRow, t: Translator, state: Unavailable): Promise<string> {
  if (state === "gone" || state === "noAccess" || state === "guest") await updateLink(link.id, { agentId: null, agentConversationId: null });
  return escapeHtml(t(`agent.states.${state}`));
}

/** Why a message wasn't taken, said. */
async function refused(link: ChatLinkRow, t: Translator, code: AgentChatError) {
  if (code === "gone" || code === "noAccess" || code === "guest" || code === "paused" || code === "aiOff" || code === "limitReached") {
    return void (await send(chatOf(link), await unavailable(link, t, code)));
  }
  if (code === "tooLong") return void (await send(chatOf(link), escapeHtml(t("agent.refused.tooLong", { max: MAX_AGENT_CHAT_MESSAGE }))));
  if (code === "queueFull") return void (await send(chatOf(link), escapeHtml(t("agent.refused.queueFull", { max: MAX_QUEUED }))));
  if (code === "badFile") return void (await send(chatOf(link), escapeHtml(t("agent.refused.badFile", { size: formatBytes(AGENT_CHAT_FILE_LIMITS.bytes) }))));
  await send(chatOf(link), escapeHtml(t(`agent.refused.${code === "busy" || code === "rateLimited" || code === "summaryFailed" ? code : "invalid"}`)));
}

/**
 * The conversation a message (or `/new summary`) from the link goes to: the latest of the agent's
 * own chat with the person, as in the app; none after /new, until a message opens one.
 */
const conversationOf = async (link: ChatLinkRow, agentId: string) => (link.agentConversationId ? await latestThreadConversation(link.userId, agentId) : null);

/**
 * Sends a message (and the text file it carries) to the link's agent and follows its answer into
 * the chat, then the turns that queued messages from here start after it. A message sent while the
 * agent answers is only queued: said so, the follow under way takes its answer; with none here on
 * that answer, it is waited for (not shown) and the turn that takes the message followed. Runs
 * inside the person's connected-app call.
 */
export async function askAgent(
  link: ChatLinkRow,
  t: Translator,
  workspace: Workspace,
  question: string,
  files: { name: string; text: string }[],
  signal: AbortSignal,
  hooks: FollowHooks,
) {
  const agentId = link.agentId!;
  const message = (conversationId: string | null) =>
    asWrite(() => sendAgentChat(link.userId, { workspaceId: workspace.id, agentId, place: null, conversationId, message: question, files, via: link.channel }));
  let sent;
  try {
    const conversationId = await conversationOf(link, agentId);
    try {
      sent = await message(conversationId);
    } catch (error) {
      // The conversation was deleted in the meantime: a new one.
      if (!(error instanceof AgentChatRefusal && error.code === "noAccess" && conversationId)) throw error;
      sent = await message(null);
    }
  } catch (error) {
    if (error instanceof ConnectedAppReadOnlyError) return void (await send(chatOf(link), html(t, "agent.readOnlyWorkspace", { workspace: escapeHtml(workspace.name) })));
    if (error instanceof AgentChatRefusal) return refused(link, t, error.code);
    throw error;
  }
  if (sent.conversation.id !== link.agentConversationId) {
    link.agentConversationId = sent.conversation.id;
    await updateLink(link.id, { agentConversationId: sent.conversation.id });
  }
  const agent = escapeHtml(agentLabel(sent.agent));
  let runId: string | null;
  if (!("behind" in sent)) {
    runId = sent.runId;
    await hooks.claim();
  } else {
    await send(chatOf(link), escapeHtml(t("agent.queued")));
    if (watched.has(`${link.id}:${sent.behind}`)) return;
    // No follow here takes its answer: the chat is free meanwhile, and /stop or /unlink end the wait.
    hooks.release();
    runId = await waitBehind(link, t, sent.behind, agent, signal, hooks);
  }
  while (runId && !signal.aborted) runId = await follow(link, t, workspace, runId, agent, signal, hooks);
}

/**
 * Waits, without showing it, for the answer a message from here was queued behind to end (a run
 * asked in the app or by another app, or one whose follow ended), looking at its status only:
 * then the run that took the queue, when a message from here went with it, to follow. A wait that
 * ends otherwise (stopped, the database out of reach, a day gone) says so, as a follow does.
 */
async function waitBehind(link: ChatLinkRow, t: Translator, runId: string, agent: string, signal: AbortSignal, hooks: FollowHooks): Promise<string | null> {
  const unwatch = watch(link.id, runId);
  hooks.waiting(true);
  let failed = 0;
  const until = Date.now() + FOLLOW_MS;
  try {
    while (!signal.aborted && Date.now() < until) {
      let parked = false;
      try {
        const state = await chatRunState(link.userId, runId);
        if (!state) break;
        if (state.status === "done" || state.status === "failed") {
          const next = await nextQueuedRun(link.userId, runId);
          hooks.waiting(false);
          return toFollow(link, next);
        }
        parked = state.status === "awaiting_approval";
        failed = 0;
      } catch (error) {
        if (++failed >= MAX_FAILED_LOOKS) {
          console.error(`[${link.channel}] couldn't wait for an agent's answer`, error);
          break;
        }
      }
      await pause(parked ? WAITING_POLL_MS : POLL_MS, signal);
    }
    await send(chatOf(link), html(t, "agent.stopped", { agent }));
    return null;
  } finally {
    unwatch();
  }
}

/**
 * `/new summary`: a new conversation with the link's agent that starts from a summary of the one
 * going on (agents/chat.ts summarizeAgentConversation); the summary, said. Runs inside the
 * person's connected-app call.
 */
export async function newAgentConversationFromSummary(link: ChatLinkRow, t: Translator, workspace: Workspace) {
  const agentId = link.agentId;
  const conversationId = agentId ? await conversationOf(link, agentId) : null;
  if (!agentId || !conversationId) return void (await send(chatOf(link), escapeHtml(t("agent.nothingToSummarize"))));
  let made;
  try {
    made = await asWrite(() => summarizeAgentConversation(link.userId, { workspaceId: workspace.id, agentId, place: null, conversationId }));
  } catch (error) {
    if (error instanceof ConnectedAppReadOnlyError) return void (await send(chatOf(link), html(t, "agent.readOnlyWorkspace", { workspace: escapeHtml(workspace.name) })));
    if (error instanceof AgentChatRefusal) {
      // A conversation deleted in the meantime has nothing to sum up either.
      if (error.code === "invalid" || error.code === "noAccess") return void (await send(chatOf(link), escapeHtml(t("agent.nothingToSummarize"))));
      return refused(link, t, error.code);
    }
    throw error;
  }
  link.agentConversationId = made.conversation.id;
  await updateLink(link.id, { agentConversationId: made.conversation.id });
  const chat = chatOf(link);
  await sendPatiently(chat, packFor(chat, [escapeHtml(t("agent.newSummary")), ...markdownToTelegramBlocks(made.summary)]));
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
 * Edits a message (the transport sends it again as plain text when its markup is refused). False
 * when it wasn't edited (too many edits, the message gone, a chat app that can't edit): the
 * preview is tried again, the answer sent anew.
 */
async function edit(chat: Chat, messageId: string, text: string): Promise<boolean> {
  if (!chat.transport.canEdit) return false;
  try {
    await chat.transport.edit(chat.id, messageId, text);
    return true;
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    return error.kind === "notModified";
  }
}

/** Sends the answer, once more after the wait the chat app asks for when it says too many messages went. */
async function sendPatiently(chat: Chat, messages: string[]) {
  try {
    await sendHtml(chat, messages);
  } catch (error) {
    if (!(error instanceof ChannelError && error.kind === "rateLimited")) throw error;
    await new Promise((resolve) => setTimeout(resolve, Math.min(MAX_RETRY_MS, error.retryAfterMs ?? 1000)));
    await sendHtml(chat, messages);
  }
}

/**
 * Follows a run of the agent's chat until it ends, its answer into the chat. The run's status is
 * read cheaply each time (chatRunState); its whole turn, with access checked again, only when it
 * ends or waits on another call. A follow that ends otherwise (stopped, access lost, the database
 * out of reach, a day gone) says the answer will be on the agent's page. Once it ended: the run
 * that took the messages queued meanwhile, when one of them came from here, to follow next.
 */
async function follow(link: ChatLinkRow, t: Translator, workspace: Workspace, runId: string, agent: string, signal: AbortSignal, hooks: FollowHooks): Promise<string | null> {
  const chat = chatOf(link);
  const unwatch = watch(link.id, runId);
  const following = new AbortController();
  const stop = () => following.abort();
  signal.addEventListener("abort", stop);
  // The text so far, from the agents' worker in this process (none from another's: the answer comes
  // whole); followed again when the run goes on after an approval, from its start each time.
  let text = "";
  void (async () => {
    while (!following.signal.aborted) {
      const events = followRun(link.userId, runId, following.signal);
      try {
        let written = "";
        for await (const event of events ?? []) {
          if (event.type === "text") written += event.text;
          else if (event.type === "reset") written = "";
          else continue;
          text = written;
        }
      } catch {
        // Followed again below.
      }
      await pause(POLL_MS, following.signal);
    }
  })();
  let previewId: string | null = null;
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
            await send(chat, html(t, "agent.deferred", { agent }));
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
          if (!(error instanceof AccessError || error instanceof AgentChatRefusal)) console.error(`[${link.channel}] couldn't follow an agent's answer`, error);
          break;
        }
      }
      // Outside the looks above: an answer that fails to go isn't sent again.
      if (ended) {
        // An answer that couldn't go (the chat app out of reach) doesn't keep the turns queued after it from being followed.
        await finish(link, t, ended, previewId, shown).catch((error) => console.error(`[${link.channel}] couldn't send an agent's answer`, error instanceof Error ? error.message : error));
        const next = await nextQueuedRun(link.userId, runId).catch(() => null);
        return toFollow(link, next);
      }
      // Shown as it is written only where the message can then be changed into the answer.
      const now = chat.transport.canEdit ? livePreview(text, previewChars(chat)) : "";
      if (now && now !== shown) {
        // Shown only once it is there: an edit that didn't go is tried again at the next look.
        if (previewId) {
          if (await edit(chat, previewId, now)) shown = now;
        } else {
          previewId = await send(chat, now).catch(() => null);
          shown = now;
        }
      }
      await pause(parked ? WAITING_POLL_MS : POLL_MS, signal);
    }
    await send(chat, html(t, "agent.stopped", { agent }));
    return null;
  } finally {
    unwatch();
    following.abort();
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Says that the run waits on a call: for this person, its approval message (deliverChatApps sends
 * it when their notifications come here now; else it is sent now); for an owner, that it waits on
 * them. False when the approval message isn't there yet (the run has only just stopped): asked
 * again, and after a few tries the chat says to answer it in Leafdesk.
 */
async function tellWaiting(link: ChatLinkRow, t: Translator, runId: string, pending: AgentChatTurn["pending"], agent: string, tries: number): Promise<boolean> {
  if (!pending) {
    await send(chatOf(link), html(t, "agent.waitingOwner", { agent }));
    return true;
  }
  const connection = escapeHtml(pending.connectionName);
  // The notification comes to this chat when the link still takes them (it may have been turned off meanwhile).
  if ((await linkById(link.id))?.notifications) {
    await send(chatOf(link), html(t, "agent.waiting", { agent, connection }));
    return true;
  }
  if (await runAsConnectedApp({ userId: link.userId }, () => sendApprovalHere(link.userId, chatOf(link), runId))) return true;
  if (tries < APPROVAL_TRIES) return false;
  await send(chatOf(link), html(t, "agent.waitingApp", { agent, connection }));
  return true;
}

/** The run's end: its answer, formatted, in place of what was shown as it was written (or anew when that can't be edited), and the files it attached; or why it failed. */
async function finish(link: ChatLinkRow, t: Translator, turn: AgentChatTurn, previewId: string | null, shown: string) {
  const chat = chatOf(link);
  if (turn.status === "failed") {
    const note = `<i>${escapeHtml(t(`agent.failed.${chatFailure(turn.code)}`))}</i>`;
    if (!(previewId && (await edit(chat, previewId, `${shown.replace(/ ✍️$/, "")}\n\n${note}`)))) await sendPatiently(chat, [note]);
    return sendFiles(link, t, turn);
  }
  const blocks = markdownToTelegramBlocks(turn.answer);
  const changes = changeLines(t, turn.steps);
  if (changes) blocks.push(changes);
  const messages = packFor(chat, blocks.length ? blocks : [escapeHtml(t("errors.empty"))]);
  if (previewId && (await edit(chat, previewId, messages[0]))) {
    if (messages.length > 1) await sendPatiently(chat, messages.slice(1));
  } else await sendPatiently(chat, messages);
  await sendFiles(link, t, turn);
}

/** Sends the files the agent attached to its answer, each as a document; one that can't go is said to be on the agent's page. */
async function sendFiles(link: ChatLinkRow, t: Translator, turn: AgentChatTurn) {
  for (const attached of turn.attached) {
    try {
      const found = await chatFileOfPerson(link.userId, attached.id);
      const body = found ? await (await storageOf(found)).get(refOf(found)) : null;
      if (!found || !body) throw new Error("missing");
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      await chatOf(link).transport.sendDocument(link.chatId, { name: found.name, contentType: found.contentType, bytes });
    } catch (error) {
      if (!(error instanceof ChannelError)) console.error(`[${link.channel}] couldn't send an agent's file`, error instanceof Error ? error.message : error);
      await send(chatOf(link), html(t, "agent.fileNotSent", { name: escapeHtml(attached.name) })).catch(() => {});
    }
  }
}
