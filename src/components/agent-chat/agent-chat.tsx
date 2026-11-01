"use client";

/**
 * A chat with an agent (see lib/agent-chat.ts), on its own page, in its dialog's Chat tab and in a
 * page's block, with the box to write in. Each message is one of the agent's runs, done by its
 * worker: the chat follows the run (its steps as they come, then its answer) by asking for it again
 * every second, shows its answer as it is written (`/api/agents/chat/live`), and for the owner
 * whose turn it is, shows the call it waits on to approve. On the
 * agent's page and in its dialog it is one chat that goes on (`AgentChatThread`), where the runs
 * the person started otherwise (schedules, tasks, mentions) come in as the agent speaking up, asked
 * for again as they go on; a block keeps conversations to pick from. A message written while the
 * agent answers waits in the conversation's queue (shown under the answer, each removable) and goes
 * as the next turn; the box takes a few text files (chat-files.tsx); the last turn can be done again
 * or its question edited; a conversation can go on as a new one from its summary; and the person's
 * conversations with the agent can be searched (chat-search.tsx, loaded when opened). Loaded only
 * where a chat is shown.
 */
import { ArrowUp, AtSign, Check, ChevronRight, Clock, ListChecks, Loader2, Mail, Paperclip, Pencil, Plus, RotateCcw, ScrollText, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteAgentConversationAction,
  redoAgentChatAction,
  removeQueuedAgentChatAction,
  sendAgentChatAction,
  summarizeAgentConversationAction,
} from "@/app/actions/agent-chat";
import { undoAgentCorrectionAction } from "@/app/actions/agents";
import type { ChatMemoryRecord } from "@/db/schema/ai";
import { AnswerText } from "@/components/ai-chat/answer-text";
import { StepLine } from "@/components/ai-chat/step-line";
import { ChangedPagesBox, changedPages } from "@/components/ai-chat/chat-side";
import { scrollingBox, ToLatest, TurnLines } from "@/components/chat-navigation";
import { CopyAction, MessageTime, questionBox, revealed, StepsFold } from "@/components/ai-chat/message-parts";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { AgentIcon, AgentStepLine } from "@/components/settings/agent-dialog";
import { SideBox, SideItem } from "@/components/side-box";
import { Button, cn, IconButton, selectClass } from "@/components/ui";
import {
  applyLiveEdit,
  chatFailure,
  MAX_AGENT_CHAT_MESSAGE,
  type AgentChatFileIn,
  type AgentChatInfo,
  type AgentChatMessageView,
  type AgentChatQueuedView,
  type AgentChatSearchHit,
  type AgentChatRunView,
  type AgentChatStepView,
  type AgentChatTurn,
  type ChatPlace,
  type LiveTextEdit,
} from "@/lib/agent-chat";
import { AGENT_CHAT_FILE_ACCEPT } from "@/lib/agent-chat-files";
import { AnswerFiles, FileChips, readChatFiles, useFileProblem } from "./chat-files";

const ChatSearch = lazyPart(() => import("./chat-search").then((m) => m.ChatSearch));
const ComputerNote = lazyPart(() => import("./computer-note").then((m) => m.ComputerNote));
const RunProposals = lazyPart(() => import("./run-proposals").then((m) => m.RunProposals));

const NO_SOURCES = new Map();
const noop = () => {};
/** How often a turn under way is asked for. */
const POLL_MS = 1_000;
/** How often the agent's own chat asks for its runs again: while one goes on, and otherwise. */
const RUNS_BUSY_MS = 3_000;
const RUNS_IDLE_MS = 30_000;
const runGoesOn = (r: AgentChatRunView) => r.status === "pending" || r.status === "running" || r.status === "awaiting_approval";

/** Where the page was opened to: a conversation of a block's and a message to bring into view (a search hit from another place). */
function openedAt(): { conversation: string | null; at: string | null } {
  if (typeof window === "undefined") return { conversation: null, at: null };
  const params = new URLSearchParams(window.location.search);
  return { conversation: params.get("agentChat"), at: params.get("at") };
}

/** The lines of newline-delimited JSON, each as it comes. */
async function* jsonLines<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
  }
}

export function AgentChat({
  workspaceId,
  agentId,
  place,
  variant,
  focusRun = null,
  side = null,
  lines = null,
}: {
  workspaceId: string;
  agentId: string;
  place: ChatPlace;
  variant: "page" | "dialog" | "block";
  /** One of the agent's own chat's runs to bring into view once it loads, instead of the end (a report opened from the inbox). */
  focusRun?: string | null;
  /** The agent's page: where its boxes go beside the chat (the runs, what they changed). */
  side?: HTMLElement | null;
  /** The agent's page: where the lines to its questions go, at the chat's side. */
  lines?: HTMLElement | null;
}) {
  const t = useTranslations("page.agentChat");
  const tc = useTranslations("common");
  const router = useRouter();
  const [info, setInfo] = useState<AgentChatInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessageView[]>([]);
  const [connections, setConnections] = useState<Record<string, string>>({});
  // The agent's own chat (no place): the person's runs other than chats, among the messages.
  const [runs, setRuns] = useState<AgentChatRunView[]>([]);
  // The run answering the last message, and how it stands, while it is under way.
  const [running, setRunning] = useState<string | null>(null);
  // The run whose answer came here while the chat was open: it flows in rather than showing at once.
  const [arrived, setArrived] = useState<string | null>(null);
  const [turn, setTurn] = useState<AgentChatTurn | null>(null);
  // What that run has written so far, as it writes it.
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  // Whether its writing is followed now, and a count raised to follow it again.
  const followed = useRef(false);
  const [followAgain, setFollowAgain] = useState(0);
  const [input, setInput] = useState("");
  // The messages waiting for the answer under way, and the files the box carries.
  const [queued, setQueued] = useState<AgentChatQueuedView[]>([]);
  const [files, setFiles] = useState<AgentChatFileIn[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileProblem = useFileProblem();
  // The last question being edited (its text), the search open, and a summary being written.
  const [editing, setEditing] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chatId = place?.chatId ?? null;
  const pageId = place?.pageId ?? null;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  // The place as a stable value for the effects (a new object on every render of the block).
  const placeRef = useRef(place);
  placeRef.current = place;
  const thread = place === null;
  // The page's chat scrolls with the box the page is in (the lines and the button follow it).
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const loaded = info !== null;
  useEffect(() => {
    if (variant === "page" && loaded) setScroller(scrollingBox(listRef.current));
  }, [variant, loaded]);

  // `asked`: the thread's read already under way (load starts it beside the chat's info).
  const openThread = useCallback(async (asked?: ReturnType<typeof read<"agentThread">>) => {
    setError(null);
    setTurn(null);
    const res = await (asked ?? read("agentThread", workspaceId, agentId));
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConversationId(res.data.conversationId);
    setMessages(res.data.messages);
    setRuns(res.data.runs);
    setConnections(res.data.connections);
    setRunning(res.data.running);
    setQueued(res.data.queued);
  }, [workspaceId, agentId]);

  const refreshRuns = useCallback(async () => {
    const res = await read("agentThreadRuns", workspaceId, agentId).catch(() => null);
    if (!res?.ok) return;
    setRuns(res.data.runs);
    setConnections((c) => ({ ...c, ...res.data.connections }));
  }, [workspaceId, agentId]);

  const open = useCallback(
    async (id: string | null) => {
      setError(null);
      setTurn(null);
      setEditing(null);
      if (!id) {
        setConversationId(null);
        setMessages([]);
        setRunning(null);
        setQueued([]);
        return;
      }
      const res = await read("agentConversation", workspaceId, agentId, id, placeRef.current);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConversationId(res.data.id);
      setMessages(res.data.messages);
      setConnections(res.data.connections);
      setRunning(res.data.running);
      setQueued(res.data.queued);
    },
    [workspaceId, agentId],
  );

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      // The agent's own chat reads its thread beside its info; if the agent is gone, it is never shown.
      const thread = placeRef.current === null ? read("agentThread", workspaceId, agentId) : undefined;
      void thread?.catch(() => {});
      const res = await read("agentChatInfo", workspaceId, agentId, placeRef.current);
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setInfo(res.data);
      // Back where they were: the agent's own chat, or a block's latest conversation (or the one a search hit opened the page to).
      if (placeRef.current === null) {
        if (res.data.agent) await openThread(thread);
      } else {
        const asked = openedAt().conversation;
        await open(res.data.conversations.find((c) => c.id === asked)?.id ?? res.data.conversations[0]?.id ?? null);
      }
    } catch {
      setLoadFailed(true);
    }
  }, [workspaceId, agentId, open, openThread]);

  useEffect(() => {
    // The answers' renderer (the AI chat's), while the messages load.
    void AnswerText.preload();
    void load();
    // chatId and pageId stand for the place: another block's chat loads again.
  }, [load, chatId, pageId]);

  // A turn under way: asked for every second until its run ends, then its answer joins the messages.
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await read("agentChatTurn", workspaceId, running).catch(() => null);
      if (!live) return;
      if (res?.ok) {
        setTurn(res.data);
        setConnections((c) => ({ ...c, ...res.data.connections }));
        if (res.data.status === "done" || res.data.status === "failed") {
          const ended = res.data;
          // Under the same key as the answer being written: it goes on flowing from where it was.
          setMessages((list) => [
            ...list,
            {
              role: "assistant",
              content: ended.answer,
              runId: ended.runId,
              code: ended.status === "failed" ? (ended.code ?? "error") : null,
              steps: ended.steps,
              ...(ended.attached.length ? { attached: ended.attached } : {}),
              at: new Date().toISOString(),
            },
          ]);
          setArrived(ended.runId);
          setTurn(null);
          setLive(null);
          setRunning(null);
          // The messages that waited went on as the next turn: the conversation is read again, with them and the run.
          if (ended.next) void (placeRef.current === null ? openThread() : open(conversationRef.current));
          else setQueued([]);
          return;
        }
        setQueued(res.data.queued);
        // Its writing is followed again when the follow ended while it goes on (it went on after an approval).
        if ((res.data.status === "running" || res.data.status === "pending") && !followed.current) setFollowAgain((n) => n + 1);
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [running, workspaceId, open, openThread]);

  // What the turn under way writes, as it writes it (server/agents/live-text.ts): edits to its text.
  // Only the person's own chat runs in this process are written here; others' answers come whole.
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    followed.current = true;
    void (async () => {
      let again = false;
      try {
        const res = await fetch(`/api/agents/chat/live?workspace=${encodeURIComponent(workspaceId)}&run=${encodeURIComponent(running)}`, {
          headers: { "x-leafdesk-chat": "1" },
          signal: controller.signal,
        });
        // Refused: the answer comes whole when the run ends, as it would without this.
        if (!res.ok || !res.body) return;
        again = true;
        for await (const edit of jsonLines<LiveTextEdit>(res.body)) {
          setLive((was) => {
            const before = was?.runId === running ? was.text : "";
            const text = applyLiveEdit(before, edit);
            return was && text === before ? was : { runId: running, text };
          });
        }
      } catch {
        // Cut off: followed again while the run goes on.
      } finally {
        if (again && !controller.signal.aborted) followed.current = false;
      }
    })();
    return () => {
      controller.abort();
      followed.current = false;
    };
  }, [running, workspaceId, followAgain]);

  // The agent's own chat asks for its runs again: often while one goes on, now and then for new ones.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const hasAgent = Boolean(info?.agent);
  useEffect(() => {
    if (!thread || !hasAgent) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          if (document.visibilityState === "visible") void refreshRuns().finally(next);
          else next();
        },
        runsRef.current.some(runGoesOn) ? RUNS_BUSY_MS : RUNS_IDLE_MS,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [thread, hasAgent, refreshRuns]);

  // The run to bring into view (marked for a moment): kept there while the chat loads, again too,
  // until something new comes in (a message, a run under way, another run). `runs`: how many runs
  // there were when it came into view.
  const focusRef = useRef<{ id: string; runs: number | null } | null>(focusRun ? { id: focusRun, runs: null } : null);
  // A message to bring into view (a search hit), by when it was written.
  const focusAt = useRef<string | null>(openedAt().at);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => setFocused(null), 2_500);
    return () => clearTimeout(timer);
  }, [focused]);

  // Follows the conversation as it grows.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const at = focusAt.current;
    if (at && messages.length > 0) {
      focusAt.current = null;
      const item = el.querySelector<HTMLElement>(`[data-at="${CSS.escape(at)}"]`);
      if (item) {
        setFocused(at);
        item.scrollIntoView({ block: "center" });
        return;
      }
    }
    const focus = focusRef.current;
    if (focus && (messages.length > 0 || runs.length > 0)) {
      // One of the latest runs only (THREAD_RUNS); an older one leaves the chat at its end.
      const item = el.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(focus.id)}"]`);
      if (item && !running && (focus.runs === null || focus.runs === runs.length)) {
        if (focus.runs === null) setFocused(focus.id);
        focus.runs = runs.length;
        item.scrollIntoView({ block: "start" });
        return;
      }
      focusRef.current = null;
    }
    // The page's list grows with the window's scroll (its scroll margin keeps it above the box);
    // the others scroll on their own.
    if (variant === "page") el.scrollIntoView({ block: "end" });
    else el.scrollTop = el.scrollHeight;
  }, [messages, runs.length, turn?.steps.length, running, variant]);
  // The answer being written, and then one that came, flow in (smooth-text.ts): the conversation
  // follows it to its end, if it was there (someone who scrolled up to read stays where they are).
  const flowing = running ?? arrived;
  const writing = running !== null;
  useEffect(() => {
    const el = listRef.current;
    const box = variant === "page" ? scrollingBox(el) : el;
    if (!el || !box || !flowing) return;
    const until = writing ? Infinity : performance.now() + 3_000;
    let atEnd = true;
    const onScroll = () => (atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 160);
    // The window's own scrolling is told to the window.
    const target = box === document.scrollingElement ? window : box;
    target.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (performance.now() > until) observer.disconnect();
      else if (!atEnd) return;
      else if (variant === "page") el.scrollIntoView({ block: "end" });
      else el.scrollTop = el.scrollHeight;
    });
    observer.observe(el.firstElementChild ?? el);
    return () => {
      target.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [flowing, writing, variant]);

  const state = info?.state;
  const canChat = state === "full" || state === "readOnly";

  // The chat's standing changed (the agent paused or gone, the month's tokens used up…).
  const refused = (res: { error: string; code?: string }) => {
    setError(res.error);
    if (res.code && ["guest", "gone", "noAccess", "paused", "aiOff", "limitReached"].includes(res.code)) void read("agentChatInfo", workspaceId, agentId, placeRef.current).then((r) => r.ok && setInfo(r.data));
  };

  const send = async () => {
    const message = input.trim();
    if ((!message && !files.length) || !info?.agent || !canChat || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendAgentChatAction({ workspaceId, agentId, place: placeRef.current, conversationId, message, files: files.map((f) => ({ name: f.name, text: f.text })) });
      if (!res.ok) return refused(res);
      const sent = res.data;
      setInput("");
      setFiles([]);
      setConversationId(sent.conversation.id);
      setInfo((current) => current && { ...current, conversations: [sent.conversation, ...current.conversations.filter((c) => c.id !== sent.conversation.id)] });
      // Written while the agent answers: it waits for the answer.
      if (!sent.runId) return setQueued((list) => [...list, sent.queued!]);
      const refs = files.map((f) => ({ name: f.name, size: f.size }));
      setMessages((list) => [...list, { role: "user", content: message, runId: sent.runId!, code: null, steps: [], ...(refs.length ? { files: refs } : {}), at: new Date().toISOString() }]);
      setRunning(sent.runId);
    } catch {
      setError(tc("genericError"));
    } finally {
      setSending(false);
    }
  };

  const attach = async (picked: File[]) => {
    if (!picked.length) return;
    setError(null);
    const read = await readChatFiles(picked, files).catch(() => null);
    if (!read) return setError(tc("genericError"));
    if (!read.ok) return setError(fileProblem(read.problem, read.name));
    setFiles(read.files);
  };

  const unqueue = async (id: string) => {
    if (!conversationId) return;
    const res = await removeQueuedAgentChatAction(workspaceId, agentId, conversationId, id, placeRef.current);
    if (!res.ok) return setError(res.error);
    setQueued(res.data.queued);
    if (res.data.removed) return;
    // Sent meanwhile, as the answer before it ended: the conversation, read again, shows it now.
    await (placeRef.current === null ? openThread() : open(conversationId));
    setError(t("queuedAlreadySent"));
  };

  const summarize = async () => {
    if (!conversationId || summarizing) return;
    setSummarizing(true);
    setError(null);
    try {
      const res = await summarizeAgentConversationAction(workspaceId, agentId, conversationId, placeRef.current);
      if (!res.ok) return refused(res);
      const { conversation } = res.data;
      setInfo((current) => current && { ...current, conversations: [conversation, ...current.conversations] });
      await (placeRef.current === null ? openThread() : open(conversation.id));
    } catch {
      setError(tc("genericError"));
    } finally {
      setSummarizing(false);
    }
  };

  // Regenerate (no message) or Edit: the last turn again; the conversation is read again with its new run.
  const redo = async (message: string | null) => {
    if (!conversationId || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await redoAgentChatAction(workspaceId, agentId, conversationId, message, placeRef.current);
      if (!res.ok) return refused(res);
      setEditing(null);
      await (placeRef.current === null ? openThread() : open(res.data.conversation.id));
    } catch {
      setError(tc("genericError"));
    } finally {
      setSending(false);
    }
  };

  // A search hit: its message here when this place holds it, else the place that does.
  const pick = async (hit: AgentChatSearchHit) => {
    setSearching(false);
    if (hit.chatId === chatId) {
      if (!thread && hit.conversationId !== conversationId) await open(hit.conversationId);
      focusAt.current = hit.at;
      // The focus effect runs as the messages change; it is asked to run now for the same ones.
      setMessages((list) => [...list]);
      return;
    }
    if (hit.chatId === null) return router.push(`/w/${workspaceId}/agents/${agentId}?at=${encodeURIComponent(hit.at)}`);
    if (hit.pageId) router.push(`/w/${workspaceId}/p/${hit.pageId}?agentChat=${encodeURIComponent(hit.conversationId)}&at=${encodeURIComponent(hit.at)}`);
  };

  const remove = async () => {
    if (!conversationId) return;
    const res = await deleteAgentConversationAction(workspaceId, agentId, conversationId, placeRef.current);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const left = (info?.conversations ?? []).filter((c) => c.id !== conversationId);
    setInfo((current) => current && { ...current, conversations: left });
    await open(left[0]?.id ?? null);
  };

  // A correction an answer kept at once, taken back: its step reads as undone.
  const undoCorrection = async (runId: string, memoryId: string, index: number): Promise<string | null> => {
    const res = await undoAgentCorrectionAction(workspaceId, runId, memoryId, index).catch(() => null);
    if (!res) return tc("genericError");
    if (!res.ok) return res.error;
    // That step alone: another correction of the same note in the answer keeps its Undo.
    const undone = (steps: AgentChatStepView[]) =>
      steps.map((s, i) => (i === index && s.kind === "memory" && s.action === "correct" && s.memoryId === memoryId ? { ...s, outcome: "undone" as const } : s));
    setMessages((list) => list.map((m) => (m.role === "assistant" && m.runId === runId ? { ...m, steps: undone(m.steps) } : m)));
    return null;
  };

  const openPage = (id: string) => router.push(`/w/${workspaceId}/p/${id}`);
  const items = timeline(messages, runs, thread);
  // When each question was asked, for how long its answer took.
  const askedAt = new Map<string, string>();
  for (const m of messages) if (m.role === "user" && !askedAt.has(m.runId)) askedAt.set(m.runId, m.at);
  const block = variant === "block";
  const page = variant === "page";
  const answers = new Map(messages.flatMap((m) => (m.role === "assistant" ? [[m.runId, m.content] as const] : [])));
  // Questions that waited together are one turn (one run).
  const turns: { id: string; question: string; answer: string }[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const last = turns.at(-1);
    if (last?.id === m.runId) last.question = `${last.question}\n\n${m.content}`;
    else turns.push({ id: m.runId, question: m.content, answer: answers.get(m.runId) ?? "" });
  }

  if (loadFailed) {
    return (
      <Frame block={block}>
        <p role="alert" className="px-3 py-3 text-sm text-fg-muted">
          {t("loadFailed")}{" "}
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => void load()}>
            {t("retry")}
          </button>
        </p>
      </Frame>
    );
  }
  if (!info) {
    return (
      <Frame block={block}>
        <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />
      </Frame>
    );
  }
  if (!info.agent || state === "guest" || state === "gone" || state === "noAccess") {
    return (
      <Frame block={block}>
        <p className="flex items-center gap-2 px-3 py-3 text-sm text-fg-muted" data-agent-chat-state={state}>
          <AgentIcon icon={null} />
          {t(`states.${state === "guest" || state === "noAccess" ? state : "gone"}`)}
        </p>
      </Frame>
    );
  }

  const agent = info.agent;
  const blocked = state === "paused" || state === "aiOff" || state === "limitReached" ? t(`states.${state}`) : null;
  const waiting = turn?.pending && state === "full" ? turn.pending : null;
  // The last turn may be done again (or its question edited) once it ended and nothing waits.
  const lastMessage = messages.at(-1);
  const redoable = canChat && !blocked && !running && !queued.length && !sending && lastMessage?.role === "assistant" && !lastMessage.summary && conversationId !== null;
  const redoRun = redoable ? lastMessage.runId : null;
  const lastQuestionAt = redoRun ? messages.findLast((m) => m.role === "user" && m.runId === redoRun)?.at : undefined;
  const busy = Boolean(running) || queued.length > 0;
  const tools = (
    <>
      <IconButton label={t("search.open")} title={t("search.open")} className="h-7 w-7" onPointerEnter={() => void ChatSearch.preload()} onClick={() => setSearching((on) => !on)}>
        <Search className="h-3.5 w-3.5" />
      </IconButton>
      {canChat && conversationId && messages.length > 0 && (
        <IconButton label={t("newWithSummary")} title={t("newWithSummary")} className="h-7 w-7" disabled={busy || summarizing} onClick={() => void summarize()}>
          {summarizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScrollText className="h-3.5 w-3.5" />}
        </IconButton>
      )}
    </>
  );

  return (
    <Frame block={block}>
      {/* The block always names its agent and keeps conversations; the agent's own chat is one, its row only says it's read-only. */}
      {(block || state === "readOnly" || thread) && (
        <div className={cn("flex items-center gap-2", block ? "border-b border-border px-3 py-2" : "pb-2")}>
          {block && (
            <>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-hover text-sm">
                <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
            </>
          )}
          {state === "readOnly" && (
            <span className="shrink-0 rounded border border-border px-1.5 text-xs text-fg-muted" title={t("readOnlyHint")}>
              {t("readOnly")}
            </span>
          )}
          {!block && <div className="ms-auto flex items-center gap-0.5">{tools}</div>}
          {block && (
            <div className="ms-auto flex min-w-0 items-center gap-0.5">
              {tools}
              {info.conversations.length > 0 && (
                <select
                  aria-label={t("conversations")}
                  className={cn(selectClass, "h-7 max-w-44 min-w-0 truncate text-xs")}
                  value={conversationId ?? ""}
                  disabled={Boolean(running)}
                  onChange={(e) => void open(e.target.value || null)}
                >
                  {!conversationId && <option value="">{t("newConversation")}</option>}
                  {info.conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
              <IconButton label={t("newConversation")} title={t("newConversation")} className="h-7 w-7" disabled={Boolean(running) || !conversationId} onClick={() => void open(null)}>
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
              {conversationId && (
                <IconButton label={t("deleteConversation")} title={t("deleteConversation")} className="h-7 w-7" disabled={Boolean(running)} onClick={() => void remove()}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </div>
          )}
        </div>
      )}

      {searching && <ChatSearch workspaceId={workspaceId} agentId={agentId} agentName={agent.name} onPick={(hit) => void pick(hit)} onClose={() => setSearching(false)} />}
      <div ref={listRef} className={cn(page ? "min-h-24 scroll-mb-28 py-4" : "overflow-y-auto", block ? "max-h-[28rem] px-3 py-3" : !page && "-mx-2 max-h-[45vh] px-2 py-2")} aria-live="polite">
        {messages.length === 0 && runs.length === 0 ? (
          <p className="text-sm text-fg-muted">{t(`empty.${state === "full" ? (thread ? "thread" : "full") : "readOnly"}`, { name: agent.name })}</p>
        ) : (
          <ol className={page ? "space-y-6" : "space-y-4"}>
            {/* One list with the turn under way: its answer keeps its place (and its key) once it ends. */}
            {[
              ...items.map((item, i) =>
              item.day ? (
                <li key={`day-${item.at}`} className="pt-2 text-center text-xs text-fg-muted">
                  <DayLabel at={item.at} />
                </li>
              ) : item.run ? (
                <li
                  key={`run-${item.run.id}`}
                  data-run-id={item.run.id}
                  className={cn("-mx-2 -my-1 scroll-mt-20 rounded-lg px-2 py-1 transition-colors duration-700", focused === item.run.id && "bg-bg-hover")}
                >
                  <RunMessage
                    workspaceId={workspaceId}
                    run={item.run}
                    connections={connections}
                    last={!running && i === items.length - 1}
                    onOpen={openPage}
                    onAnswered={() => void refreshRuns()}
                  />
                </li>
              ) : (
                <li
                  // An answer keeps the key it was written under; several questions can share a run.
                  key={item.message.summary ? `summary-${item.message.at}` : item.message.role === "assistant" ? `assistant-${item.message.runId}` : `user-${item.message.runId}-${item.message.at}`}
                  data-turn={item.message.role === "user" ? item.message.runId : undefined}
                  data-at={item.message.at}
                  className={cn("-mx-2 -my-1 rounded-lg px-2 py-1 transition-colors duration-700", focused === item.message.at && "bg-bg-hover")}
                >
                  {item.message.summary ? (
                    <SummaryNote message={item.message} />
                  ) : item.message.role === "user" ? (
                    editing !== null && item.message.at === lastQuestionAt ? (
                      <EditQuestion text={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSend={() => void redo(editing)} busy={sending} />
                    ) : (
                      <Question message={item.message} page={page} onEdit={item.message.at === lastQuestionAt ? () => setEditing(item.message.content) : undefined} />
                    )
                  ) : (
                    <Answer
                      workspaceId={workspaceId}
                      message={item.message}
                      ms={tookMs(item.message, askedAt)}
                      last={!running && i === items.length - 1}
                      arrived={item.message.runId === arrived}
                      connections={connections}
                      onOpen={openPage}
                      onRedo={item.message.runId === redoRun && editing === null ? () => void redo(null) : undefined}
                      onUndo={(memoryId, index) => undoCorrection(item.message.runId, memoryId, index)}
                    />
                  )}
                </li>
              ),
            ),
              ...(running
                ? [
                    <li key={`assistant-${running}`}>
                      <Answer
                        workspaceId={workspaceId}
                        message={{ role: "assistant", content: live?.runId === running ? live.text : "", runId: running, code: null, steps: turn?.steps ?? [], at: "" }}
                        ms={undefined}
                        last={false}
                        arrived
                        connections={connections}
                        onOpen={openPage}
                        live={{ workspaceId, status: turn?.status ?? "pending", pending: waiting, deferredUntil: turn?.deferredUntil ?? null, startedAt: askedAt.get(running) }}
                      />
                      {turn && turn.attached.length > 0 && <AnswerFiles files={turn.attached} />}
                    </li>,
                  ]
                : []),
              // Messages waiting for the answer under way, each removable before it goes.
              ...queued.map((q) => (
                <li key={`queued-${q.id}`} data-queued={q.id}>
                  <QueuedQuestion item={q} page={page} name={agent.name} onRemove={() => void unqueue(q.id)} />
                </li>
              )),
            ]}
          </ol>
        )}
      </div>

      <div className={cn(block ? "border-t border-border px-3 py-2" : page ? "sticky bottom-0 bg-bg pb-6" : "pt-2")}>
        {page && <ToLatest scroller={scroller} className="absolute -top-12 left-1/2 z-10 -translate-x-1/2" />}
        {(blocked || error) && (
          <p role={error ? "alert" : "status"} className={cn("mb-1.5 text-xs", error ? "text-danger" : "text-fg-muted")}>
            {error ?? blocked}
          </p>
        )}
        {info?.computer && <ComputerNote folders={info.computer} />}
        <form
          className={cn("flex flex-wrap items-end gap-2", page && "rounded-xl border border-border bg-bg px-3 py-2 shadow-sm")}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {files.length > 0 && <FileChips files={files} className="flex w-full flex-wrap gap-1.5" onRemove={(name) => setFiles((list) => list.filter((f) => f.name !== name))} />}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={AGENT_CHAT_FILE_ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              void attach(picked);
            }}
          />
          <IconButton label={t("files.attach")} title={t("files.attach")} className="mb-0.5 h-7 w-7" disabled={!canChat} onClick={() => fileInput.current?.click()}>
            <Paperclip className="h-3.5 w-3.5" />
          </IconButton>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // The page's editor around the block never sees the chat's keys.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => e.stopPropagation()}
            rows={Math.min(5, Math.max(1, input.split("\n").length))}
            maxLength={MAX_AGENT_CHAT_MESSAGE}
            disabled={!canChat}
            placeholder={t("placeholder", { name: agent.name })}
            aria-label={t("placeholder", { name: agent.name })}
            className="min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-fg-faint disabled:opacity-60"
          />
          <button
            type="submit"
            aria-label={t("send")}
            title={t("send")}
            disabled={!canChat || (!input.trim() && !files.length) || sending}
            className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fg text-bg transition-colors hover:bg-fg/85 disabled:bg-bg-active disabled:text-fg-faint"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
          </button>
        </form>
      </div>
      {lines && createPortal(<TurnLines scroller={scroller} turns={turns} />, lines)}
      {side &&
        createPortal(
          <SideBoxes
            messages={messages}
            runs={runs}
            onRun={(id) => {
              const item = listRef.current?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(id)}"]`);
              if (!item) return;
              setFocused(id);
              item.scrollIntoView({ block: "start" });
            }}
            onOpen={openPage}
          />,
          side,
        )}
    </Frame>
  );
}

/** Runs the boxes beside the agent's page list at most, the latest. */
const SIDE_RUNS = 10;

/**
 * The agent's page's boxes from its chat: the person's runs other than chats (one brings it into
 * view in the chat), and the pages the runs and the answers made or changed.
 */
function SideBoxes({
  messages,
  runs,
  onRun,
  onOpen,
}: {
  messages: AgentChatMessageView[];
  runs: AgentChatRunView[];
  onRun: (id: string) => void;
  onOpen: (pageId: string) => void;
}) {
  const t = useTranslations("page.agentChat");
  const ts = useTranslations("settings.agents");
  const format = useFormatter();
  const latest = [...runs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, SIDE_RUNS);
  const done = [...messages, ...runs].sort((a, b) => a.at.localeCompare(b.at)).flatMap((m) => m.steps);
  return (
    <>
      {latest.length > 0 && (
        <SideBox title={ts("tabs.runs")} count={runs.length}>
          {latest.map((run) => (
            <SideItem
              key={run.id}
              icon={
                runGoesOn(run) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : run.status === "failed" ? (
                  <TriangleAlert className="h-3.5 w-3.5 text-danger" />
                ) : (
                  <Check className={cn("h-3.5 w-3.5", run.quiet && "text-fg-faint")} />
                )
              }
              onClick={() => onRun(run.id)}
            >
              <span className="line-clamp-2 break-words">{run.label ? t(`from.${run.kind}On`, { place: run.label }) : t(`from.${run.kind}`)}</span>
              <span className="block text-xs text-fg-muted">{format.dateTime(new Date(run.at), { dateStyle: "medium", timeStyle: "short" })}</span>
            </SideItem>
          ))}
        </SideBox>
      )}
      <ChangedPagesBox pages={changedPages(done)} onOpen={(p) => onOpen(p.pageId)} />
    </>
  );
}

/** The block's box; the dialog's tab has its own. */
function Frame({ block, children }: { block: boolean; children: React.ReactNode }) {
  return block ? <div className="my-1 w-full rounded-lg border border-border bg-bg">{children}</div> : <div>{children}</div>;
}

/** A question: its text and files, and on hover when it was asked, copying it and (the last one) editing it. */
function Question({ message, page, onEdit }: { message: AgentChatMessageView; page: boolean; onEdit?: () => void }) {
  const t = useTranslations("page.agentChat");
  return (
    <div className="group/question">
      {message.content && <div className={questionBox(page)}>{message.content}</div>}
      {message.files && <FileChips files={message.files} className={cn("mt-1.5 flex flex-wrap justify-end gap-1.5", !page && "ms-8")} />}
      <div className={cn("mt-1 flex items-center justify-end gap-0.5", revealed)}>
        <MessageTime at={message.at} />
        {message.content && <CopyAction text={message.content} />}
        {onEdit && (
          <IconButton label={t("edit")} title={t("edit")} className="h-7 w-7" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/** The last question being edited: sent again, its answer written anew. */
function EditQuestion({ text, onChange, onCancel, onSend, busy }: { text: string; onChange: (text: string) => void; onCancel: () => void; onSend: () => void; busy: boolean }) {
  const t = useTranslations("page.agentChat");
  const tc = useTranslations("common");
  return (
    <div className="ms-8 rounded-lg border border-border p-2">
      <textarea
        autoFocus
        value={text}
        maxLength={MAX_AGENT_CHAT_MESSAGE}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (text.trim()) onSend();
          }
        }}
        aria-label={t("edit")}
        className="w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <button type="button" className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover" onClick={onCancel}>
          {tc("cancel")}
        </button>
        <button type="button" disabled={!text.trim() || busy} className="rounded-md bg-fg px-2 py-1 text-xs text-bg hover:bg-fg/85 disabled:bg-bg-active disabled:text-fg-faint" onClick={onSend}>
          {t("send")}
        </button>
      </div>
    </div>
  );
}

/** A message waiting for the answer under way: marked so, and taken out with its button. */
function QueuedQuestion({ item, page, name, onRemove }: { item: AgentChatQueuedView; page: boolean; name: string; onRemove: () => void }) {
  const t = useTranslations("page.agentChat");
  return (
    <div className="opacity-70">
      {item.content && <div className={cn(questionBox(page), "border border-dashed border-border bg-transparent")}>{item.content}</div>}
      {item.files.length > 0 && <FileChips files={item.files} className={cn("mt-1.5 flex flex-wrap justify-end gap-1.5", !page && "ms-8")} />}
      <div className="mt-1 flex items-center justify-end gap-1 text-xs text-fg-muted">
        <Clock className="h-3 w-3" aria-hidden />
        <span title={t("queuedHint", { name })}>{t("queued")}</span>
        <IconButton label={t("removeQueued")} title={t("removeQueued")} className="h-6 w-6" onClick={onRemove}>
          <X className="h-3 w-3" />
        </IconButton>
      </div>
    </div>
  );
}

/** The summary of an earlier conversation this one started from. */
function SummaryNote({ message }: { message: AgentChatMessageView }) {
  const t = useTranslations("page.agentChat");
  return (
    <div className="rounded-lg border border-border px-3 py-2 text-sm" data-agent-chat-summary>
      <p className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
        <ScrollText className="h-3.5 w-3.5" aria-hidden />
        {t("summary")}
      </p>
      <div className="break-words">
        <AnswerText text={message.content} sources={NO_SOURCES} onSource={noop} writing={false} />
      </div>
    </div>
  );
}

/** How long an answer took from its question, when the question is still there. */
function tookMs(answer: AgentChatMessageView, askedAt: Map<string, string>) {
  const asked = askedAt.get(answer.runId);
  return asked ? Math.max(0, Date.parse(answer.at) - Date.parse(asked)) : undefined;
}

/**
 * An answer: the steps taken to it (folded into how long it took), then what the agent said, or
 * why it couldn't answer, and copying it (on hover, but for the latest). One under way (`live`)
 * has its steps open under a running clock, with what it waits on last, then what it has written
 * so far; for the owner whose turn it is, the call to approve. It stays the same answer once it
 * ends, so its text goes on flowing from where it was.
 */
function Answer({
  workspaceId,
  message,
  ms,
  last,
  arrived = false,
  connections,
  onOpen,
  onRedo,
  onUndo,
  live = null,
}: {
  workspaceId: string;
  message: AgentChatMessageView;
  ms: number | undefined;
  last: boolean;
  /** The last answer, done again (Regenerate). */
  onRedo?: () => void;
  /** Takes back a correction this answer's run kept (once it ended; `index`: its step's): null when it was, else why not. */
  onUndo?: (memoryId: string, index: number) => Promise<string | null>;
  /** Being written, or came while the chat was open: its text flows in. */
  arrived?: boolean;
  connections: Record<string, string>;
  onOpen: (pageId: string) => void;
  live?: {
    workspaceId: string;
    status: AgentChatRunView["status"];
    pending: AgentChatTurn["pending"];
    deferredUntil?: string | null;
    startedAt: string | undefined;
    onAnswered?: () => void;
  } | null;
}) {
  const t = useTranslations("page.agentChat");
  const format = useFormatter();
  const text = message.content.trim();
  const proposed = !live && message.steps.some((s) => s.kind === "write" && s.outcome === "proposed");
  return (
    <div className="group/answer text-sm leading-normal">
      {live ? (
        <StepsFold live startedAt={live.startedAt ? Date.parse(live.startedAt) : undefined}>
          <StepItems steps={message.steps} connections={connections} onOpen={onOpen} />
          {!live.pending && (
            <li className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              {/* A call only an owner answers: the person chatting sees that it waits. */}
              <span>
                {live.status === "pending"
                  ? t("waiting")
                  : live.status === "awaiting_approval"
                    ? live.deferredUntil
                      ? t("deferred", { time: format.dateTime(new Date(live.deferredUntil), { timeStyle: "short" }) })
                      : t("awaitingOwner")
                    : t("working")}
              </span>
            </li>
          )}
        </StepsFold>
      ) : (
        message.steps.length > 0 && (
          <StepsFold live={false} ms={ms} label={t("steps", { count: message.steps.length })}>
            <StepItems steps={message.steps} connections={connections} onOpen={onOpen} onUndo={onUndo} />
          </StepsFold>
        )
      )}
      {live?.pending && (
        <div className="mb-2 rounded-lg border border-border p-3">
          <p className="mb-1.5 text-sm">
            {live.deferredUntil ? t("deferredApproval", { time: format.dateTime(new Date(live.deferredUntil), { timeStyle: "short" }) }) : t("approval")}
          </p>
          <ApprovalActions workspaceId={live.workspaceId} approval={{ runId: message.runId, ...live.pending }} onAnswered={live.onAnswered ?? noop} />
        </div>
      )}
      {text && (
        <div className="break-words">
          <AnswerText text={message.content} sources={NO_SOURCES} onSource={noop} writing={arrived} />
        </div>
      )}
      {message.code && <p className="mt-1 text-xs text-danger">{t(`failed.${chatFailure(message.code)}`)}</p>}
      {message.attached && <AnswerFiles files={message.attached} />}
      {proposed && <RunProposals workspaceId={workspaceId} runId={message.runId} />}
      {(text || onRedo) && !live && (
        <div className={cn("mt-1.5 -ms-1 flex items-center gap-0.5", !last && revealed)}>
          {text && <CopyAction text={text} />}
          {onRedo && (
            <IconButton label={t("regenerate")} title={t("regenerate")} className="h-7 w-7" onClick={onRedo}>
              <RotateCcw className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

function StepItems({
  steps,
  connections,
  onOpen,
  onUndo,
}: {
  steps: AgentChatStepView[];
  connections: Record<string, string>;
  onOpen: (pageId: string) => void;
  onUndo?: (memoryId: string, index: number) => Promise<string | null>;
}) {
  return steps.map((step, i) => (
    <li key={i} className="flex min-w-0 items-start gap-1.5">
      {onUndo && step.kind === "memory" && step.action === "correct" && step.memoryId && step.outcome !== "undone" ? (
        <CorrectionStepLine step={step} memoryId={step.memoryId} onOpen={onOpen} onUndo={(memoryId) => onUndo(memoryId, i)} />
      ) : (
        <AgentStepLine step={step} connections={connections} onOpen={onOpen} />
      )}
    </li>
  ));
}

/** A correction a chat run kept at once, with Undo (server/agents/memory.ts undoAgentCorrection). */
function CorrectionStepLine({
  step,
  memoryId,
  onOpen,
  onUndo,
}: {
  step: ChatMemoryRecord;
  memoryId: string;
  onOpen: (pageId: string) => void;
  onUndo: (memoryId: string) => Promise<string | null>;
}) {
  const tc = useTranslations("common");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <StepLine step={step} onSource={(source) => source.pageId && onOpen(source.pageId)} />
      <Button
        size="sm"
        variant="ghost"
        className="-my-0.5 h-6 shrink-0 px-1.5 text-xs"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const failed = await onUndo(memoryId);
          setPending(false);
          setError(failed);
        }}
      >
        {tc("toast.undo")}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Messages and runs in the order they happened (a run when it started); a question keeps its
 * answer next to it. The agent's own chat (`days`) marks where each day starts.
 */
function timeline(messages: AgentChatMessageView[], runs: AgentChatRunView[], days: boolean) {
  type Item =
    | { at: string; message: AgentChatMessageView; run?: undefined; day?: undefined }
    | { at: string; run: AgentChatRunView; message?: undefined; day?: undefined }
    | { at: string; day: true; message?: undefined; run?: undefined };
  const units: Item[][] = [];
  for (const message of messages) {
    if (message.role === "user" || !units.length) units.push([{ at: message.at, message }]);
    else units.at(-1)!.push({ at: message.at, message });
  }
  // The question still being answered stays last, above the answer under way drawn after the list.
  const asking = units.at(-1)?.every((item) => item.message?.role === "user") ? units.pop() : undefined;
  for (const run of runs) units.push([{ at: run.at, run }]);
  units.sort((a, b) => a[0].at.localeCompare(b[0].at));
  if (asking) units.push(asking);
  const items = units.flat();
  if (!days) return items;
  let last = "";
  return items.flatMap((item): Item[] => {
    const day = new Date(item.at).toDateString();
    if (day === last) return [item];
    last = day;
    return [{ at: item.at, day: true }, item];
  });
}

function DayLabel({ at }: { at: string }) {
  const format = useFormatter();
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return <time dateTime={at}>{format.dateTime(date, thisYear ? { weekday: "long", day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })}</time>;
}

/** A run the person started otherwise, as the agent speaking up: what started it and when, then as an answer does. */
function RunMessage({
  workspaceId,
  run,
  connections,
  last,
  onOpen,
  onAnswered,
}: {
  workspaceId: string;
  run: AgentChatRunView;
  connections: Record<string, string>;
  last: boolean;
  onOpen: (pageId: string) => void;
  onAnswered: () => void;
}) {
  const t = useTranslations("page.agentChat");
  const format = useFormatter();
  // The agent's own chat marks each day: the time is enough.
  const when = format.dateTime(new Date(run.at), { hour: "2-digit", minute: "2-digit" });
  const Icon = run.kind === "schedule" ? Clock : run.kind === "mention" ? AtSign : run.kind === "mail" ? Mail : ListChecks;
  const from = run.label ? t(`from.${run.kind}On`, { place: run.label }) : t(`from.${run.kind}`);
  if (run.quiet) return <QuietRun run={run} from={from} when={when} connections={connections} onOpen={onOpen} />;
  return (
    <div className="space-y-1 text-sm" data-agent-run={run.kind}>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted" title={run.task || undefined}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{from}</span>
        <span aria-hidden>·</span>
        <time dateTime={run.at} className="shrink-0">
          {when}
        </time>
      </p>
      {run.status === "done" && !run.answer.trim() && run.steps.length === 0 ? (
        <p className="text-fg-muted">{t("doneQuietly")}</p>
      ) : run.status === "done" || run.status === "failed" ? (
        <Answer
          workspaceId={workspaceId}
          message={{ role: "assistant", content: run.answer, runId: run.id, code: run.status === "failed" ? (run.code ?? "error") : null, steps: run.steps, at: run.at }}
          ms={run.ms ?? undefined}
          last={last}
          connections={connections}
          onOpen={onOpen}
        />
      ) : (
        <Answer
          workspaceId={workspaceId}
          message={{ role: "assistant", content: "", runId: run.id, code: null, steps: run.steps, at: run.at }}
          ms={undefined}
          last={false}
          connections={connections}
          onOpen={onOpen}
          live={{ workspaceId, status: run.status, pending: run.pending, startedAt: run.at, onAnswered }}
        />
      )}
    </div>
  );
}

/**
 * A schedule's run that found nothing new (finish_run): one muted line, with the reason it gave;
 * the line opens the steps it took, when it took some.
 */
function QuietRun({
  run,
  from,
  when,
  connections,
  onOpen,
}: {
  run: AgentChatRunView;
  from: string;
  when: string;
  connections: Record<string, string>;
  onOpen: (pageId: string) => void;
}) {
  const t = useTranslations("page.agentChat");
  const [open, setOpen] = useState(false);
  const reason = run.answer.trim();
  const line = (
    <>
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{t("nothingNew")}</span>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate">{reason || from}</span>
      <span aria-hidden>·</span>
      <time dateTime={run.at} className="shrink-0">
        {when}
      </time>
      {run.steps.length > 0 && <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} aria-hidden />}
    </>
  );
  const title = [from, run.task].filter(Boolean).join("\n") || undefined;
  return (
    <div className="text-xs text-fg-muted" data-agent-run={run.kind} data-agent-run-quiet>
      {run.steps.length > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          title={title}
          onClick={() => setOpen(!open)}
          className="-ms-1 flex max-w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-bg-hover hover:text-fg"
        >
          {line}
        </button>
      ) : (
        <p className="flex min-w-0 items-center gap-1.5" title={title}>
          {line}
        </p>
      )}
      {open && (
        <ol className="mt-1 ms-1.5 space-y-1 border-s border-border ps-3">
          <StepItems steps={run.steps} connections={connections} onOpen={onOpen} />
        </ol>
      )}
    </div>
  );
}
