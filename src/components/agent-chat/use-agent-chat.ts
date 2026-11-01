"use client";

/**
 * A chat with an agent (see lib/agent-chat.ts) as ChatThread shows it: the agent's own chat (no
 * place), or a page block's conversations. Each message is one of the agent's runs, done by its
 * worker: the chat follows the run's events where the AI chat's answers are (`GET /api/ai/chat?run=`,
 * server/ai-chat-runs.ts: its text as it is written, its steps as they are taken, `done` once its turn
 * is saved), reads the turn itself then (and every second while it can't follow it), and the agent's own
 * chat brings in the person's runs started otherwise (schedules, tasks, mentions), asked for again
 * as they go on. A message written while the agent answers waits in the conversation's queue and
 * goes as the next turn; the box takes a few text files (chat-files.tsx); the last turn can be done
 * again or its question edited; a conversation can go on as a new one from its summary.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteAgentConversationAction,
  redoAgentChatAction,
  removeQueuedAgentChatAction,
  sendAgentChatAction,
  stopAgentChatAction,
  summarizeAgentConversationAction,
} from "@/app/actions/agent-chat";
import { undoAgentCorrectionAction } from "@/app/actions/agents";
import type { ChatMessage, Reasoning, ThreadChat } from "@/components/ai-chat/use-chat";
import { read } from "@/components/read";
import {
  MAX_AGENT_CHAT_MESSAGE,
  type AgentChatFileIn,
  type AgentChatInfo,
  type AgentChatMessageView,
  type AgentChatQueuedView,
  type AgentChatRunView,
  type AgentChatStepView,
  type AgentChatTurn,
  type ChatPlace,
  type RunEvent,
} from "@/lib/agent-chat";
import { AGENT_CHAT_FILE_ACCEPT, agentChatFileType } from "@/lib/agent-chat-files";
import { readChatFiles, useFileProblem } from "./chat-files";

/** How often a turn under way is asked for: while its events can't be followed, and while they are. */
const POLL_MS = 1_000;
const FOLLOWING_POLL_MS = 10_000;
/** How often the agent's own chat asks for its runs again: while one goes on, and otherwise. */
const RUNS_BUSY_MS = 3_000;
const RUNS_IDLE_MS = 30_000;
export const runGoesOn = (r: AgentChatRunView) => r.status === "pending" || r.status === "running" || r.status === "awaiting_approval";

const NO_QUEUE: ThreadChat["queued"] = [];
const NO_REASONING: Reasoning = { get: () => "", subscribe: () => () => {} };
const noop = () => {};
const decideNothing = async () => {};

/**
 * What an agent's chat shows in a message's place (ChatMessage `item`, agent-items.tsx): an answer
 * (`live` while it is written), a run started otherwise, where a day starts, the summary it started
 * from, a message waiting for the answer under way.
 */
export type AgentItem =
  | { kind: "answer"; message: AgentChatMessageView; ms: number | undefined }
  | { kind: "live"; runId: string }
  | { kind: "run"; run: AgentChatRunView }
  | { kind: "day"; at: string }
  | { kind: "summary"; message: AgentChatMessageView }
  | { kind: "queued"; queued: AgentChatQueuedView };

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

/** Where the page was opened to: a conversation of a block's (a search hit from another place). */
export function openedAt(): { conversation: string | null; at: string | null } {
  if (typeof window === "undefined") return { conversation: null, at: null };
  const params = new URLSearchParams(window.location.search);
  return { conversation: params.get("agentChat"), at: params.get("at") };
}

/**
 * Messages and runs in the order they happened (a run when it started); a question keeps its
 * answer next to it. The agent's own chat (`days`) marks where each day starts.
 */
function timeline(messages: AgentChatMessageView[], runs: AgentChatRunView[], days: boolean) {
  type Item = { at: string; message: AgentChatMessageView; run?: undefined; day?: undefined } | { at: string; run: AgentChatRunView; message?: undefined; day?: undefined } | { at: string; day: true; message?: undefined; run?: undefined };
  const units: Item[][] = [];
  for (const message of messages) {
    if (message.role === "user" || !units.length) units.push([{ at: message.at, message }]);
    else units.at(-1)!.push({ at: message.at, message });
  }
  // The question still being answered stays last, above the answer under way drawn after it.
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

/** The turn as last read, with the steps its run's events brought since, each in its place among the run's. */
function withStreamed(turn: AgentChatTurn | null, streamed: { runId: string; steps: AgentChatStepView[] } | null, running: string | null): AgentChatTurn | null {
  if (!streamed || streamed.runId !== running || (turn && turn.runId !== streamed.runId)) return turn;
  const base: AgentChatTurn = turn ?? { runId: streamed.runId, status: "running", code: null, answer: "", steps: [], pending: null, deferredUntil: null, connections: {}, attached: [], queued: [], next: null };
  const steps = [...base.steps];
  streamed.steps.forEach((step, i) => (steps[i] = step));
  // Left out: a place none came to yet.
  return { ...base, steps: steps.filter((step) => step !== undefined) };
}

/** A question's key in the thread, which a search hit finds it by (its end is when it was asked). */
export const questionKey = (message: Pick<AgentChatMessageView, "runId" | "at">) => `user-${message.runId}-${message.at}`;

export function useAgentChat({ workspaceId, agentId, place }: { workspaceId: string; agentId: string; place: ChatPlace }) {
  const t = useTranslations("page.agentChat");
  const tc = useTranslations("common");
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
  // What that run has written so far, as it writes it, and the steps it took meanwhile (by their place).
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  const [streamed, setStreamed] = useState<{ runId: string; steps: AgentChatStepView[] } | null>(null);
  // Whether its events are followed now, a count raised to follow them again, and one to read the turn at once.
  const followed = useRef(false);
  const [followAgain, setFollowAgain] = useState(0);
  const [lookNow, setLookNow] = useState(0);
  const [input, setInput] = useState("");
  // The messages waiting for the answer under way, and the files the box carries.
  const [queued, setQueued] = useState<AgentChatQueuedView[]>([]);
  const [files, setFiles] = useState<AgentChatFileIn[]>([]);
  const fileProblem = useFileProblem();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatId = place?.chatId ?? null;
  const pageId = place?.pageId ?? null;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  // The place as a stable value for the effects (a new object on every render of the block).
  const placeRef = useRef(place);
  placeRef.current = place;
  const thread = place === null;

  // `asked`: the thread's read already under way (load starts it beside the chat's info).
  const openThread = useCallback(
    async (asked?: ReturnType<typeof read<"agentThread">>) => {
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
    },
    [workspaceId, agentId],
  );

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
  // The conversation again (its new turns and runs), wherever it is.
  const reopen = useCallback((id: string | null = conversationRef.current) => (placeRef.current === null ? openThread() : open(id)), [open, openThread]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      // The agent's own chat reads its thread beside its info; if the agent is gone, it is never shown.
      const asked = placeRef.current === null ? read("agentThread", workspaceId, agentId) : undefined;
      void asked?.catch(() => {});
      const res = await read("agentChatInfo", workspaceId, agentId, placeRef.current);
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setInfo(res.data);
      // Back where they were: the agent's own chat, or a block's latest conversation (or the one a search hit opened the page to).
      if (placeRef.current === null) {
        if (res.data.agent) await openThread(asked);
      } else {
        const wanted = openedAt().conversation;
        await open(res.data.conversations.find((c) => c.id === wanted)?.id ?? res.data.conversations[0]?.id ?? null);
      }
    } catch {
      setLoadFailed(true);
    }
  }, [workspaceId, agentId, open, openThread]);

  useEffect(() => {
    void load();
    // chatId and pageId stand for the place: another block's chat loads again.
  }, [load, chatId, pageId]);

  // A turn under way: asked for until its run ends (every second while its events aren't followed),
  // then its answer joins the messages.
  useEffect(() => {
    if (!running) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await read("agentChatTurn", workspaceId, running).catch(() => null);
      if (!on) return;
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
          setStreamed(null);
          setRunning(null);
          // The messages that waited went on as the next turn: the conversation is read again, with them and the run.
          if (ended.next) void reopen();
          else setQueued([]);
          return;
        }
        setQueued(res.data.queued);
        // Its writing is followed again when the follow ended while it goes on (it went on after an approval).
        if ((res.data.status === "running" || res.data.status === "pending") && !followed.current) setFollowAgain((n) => n + 1);
      }
      timer = setTimeout(() => void poll(), followed.current ? FOLLOWING_POLL_MS : POLL_MS);
    };
    void poll();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [running, workspaceId, reopen, lookNow]);

  // What the turn under way writes and does, as it goes: its run's events, from their start each
  // time (server/ai-chat-runs.ts). Only the person's own chat runs in this process are there, from
  // when the worker takes them until a while after they stop (for an approval, or done); anything
  // else, and the end, comes with the turn read above.
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let later: ReturnType<typeof setTimeout> | undefined;
    followed.current = true;
    void (async () => {
      let ended = false;
      try {
        const res = await fetch(`/api/ai/chat?run=${encodeURIComponent(running)}`, { headers: { "x-leafdesk-chat": "1" }, signal: controller.signal });
        // Not there (yet, or any more): followed again once the turn read finds it going on.
        if (!res.ok || !res.body) return;
        let text = "";
        for await (const event of jsonLines<RunEvent>(res.body)) {
          if (event.type === "text" || event.type === "reset") {
            text = event.type === "text" ? text + event.text : "";
            setLive({ runId: running, text });
          } else if (event.type === "agentStep") {
            setStreamed((was) => {
              // Sparse: a place none came to yet stays empty (forEach skips it).
              const steps = was?.runId === running ? was.steps.slice() : [];
              steps[event.index] = event.step;
              return { runId: running, steps };
            });
            setConnections((c) => ({ ...c, ...event.connections }));
          } else if (event.type === "done" || event.type === "error") {
            ended = true;
            setLookNow((n) => n + 1);
          }
        }
      } catch {
        // Cut off: followed again while the run goes on.
      } finally {
        if (!controller.signal.aborted) {
          followed.current = false;
          // Not there yet, or stopped without its end (waiting for an approval, put back, cut off):
          // the turn is read soon, not at the slower pace kept while following, nor at once (the
          // worker may only now take the run up).
          if (!ended) later = setTimeout(() => setLookNow((n) => n + 1), POLL_MS);
        }
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(later);
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

  const shownTurn = useMemo(() => withStreamed(turn, streamed, running), [turn, streamed, running]);

  const state = info?.state;
  const canChat = state === "full" || state === "readOnly";
  const blocked = state === "paused" || state === "aiOff" || state === "limitReached" ? t(`states.${state}`) : null;

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
      // Written while the agent answers: it waits for the answer. An answer this page doesn't follow
      // (asked from Telegram, another tab or a connected app): the conversation is read again, with
      // that turn and its run, so its answer and the next turn come here too.
      if (!sent.runId) {
        if (!running) return void reopen(sent.conversation.id);
        return setQueued((list) => [...list, sent.queued!]);
      }
      const refs = files.map((f) => ({ name: f.name, size: f.size }));
      setMessages((list) => [...list, { role: "user", content: message, runId: sent.runId!, code: null, steps: [], ...(refs.length ? { files: refs } : {}), at: new Date().toISOString() }]);
      setRunning(sent.runId);
    } catch {
      setError(tc("genericError"));
    } finally {
      setSending(false);
    }
  };

  const attach = async (picked: readonly File[]) => {
    if (!picked.length) return;
    setError(null);
    const taken = await readChatFiles(picked, files).catch(() => null);
    if (!taken) return setError(tc("genericError"));
    if (!taken.ok) return setError(fileProblem(taken.problem, taken.name));
    setFiles(taken.files);
  };

  const unqueue = async (id: string) => {
    if (!conversationId) return;
    const res = await removeQueuedAgentChatAction(workspaceId, agentId, conversationId, id, placeRef.current);
    if (!res.ok) return setError(res.error);
    setQueued(res.data.queued);
    if (res.data.removed) return;
    // Sent meanwhile, as the answer before it ended: the conversation, read again, shows it now.
    await reopen(conversationId);
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
      await reopen(conversation.id);
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
      await reopen(res.data.conversation.id);
    } catch {
      setError(tc("genericError"));
    } finally {
      setSending(false);
    }
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

  // The last turn may be done again (or its question edited) once it ended and nothing waits.
  const lastMessage = messages.at(-1);
  const redoable = canChat && !blocked && !running && !queued.length && !sending && lastMessage?.role === "assistant" && !lastMessage.summary && conversationId !== null;
  const redoRun = redoable ? lastMessage.runId : null;
  const lastQuestion = redoRun ? messages.findLast((m) => m.role === "user" && m.runId === redoRun) : undefined;

  // The thread's messages: questions as the AI chat's, everything else as the agent's items.
  const askedAt = new Map<string, string>();
  for (const m of messages) if (m.role === "user" && !askedAt.has(m.runId)) askedAt.set(m.runId, m.at);
  const item = (key: string, value: AgentItem, content = "", role: ChatMessage["role"] = "assistant"): ChatMessage => ({ key, role, content, item: value });
  const shown: ChatMessage[] = timeline(messages, runs, thread).map((entry) => {
    if (entry.day) return item(`day-${entry.at}`, { kind: "day", at: entry.at });
    if (entry.run) return item(`run-${entry.run.id}`, { kind: "run", run: entry.run }, entry.run.answer);
    const m = entry.message;
    if (m.summary) return item(`summary-${m.at}`, { kind: "summary", message: m }, m.content);
    if (m.role === "assistant") {
      const asked = askedAt.get(m.runId);
      const ms = asked ? Math.max(0, Date.parse(m.at) - Date.parse(asked)) : undefined;
      // An answer keeps the key it was written under; several questions can share a run.
      return item(`assistant-${m.runId}`, { kind: "answer", message: m, ms }, m.content);
    }
    return {
      key: questionKey(m),
      role: "user",
      content: m.content,
      at: m.at,
      ...(m.files?.length ? { attachments: m.files.map((f) => ({ id: f.name, name: f.name, contentType: "text/plain", size: f.size, url: "" })) } : {}),
    };
  });
  if (running) shown.push(item(`assistant-${running}`, { kind: "live", runId: running }, live?.runId === running ? live.text : ""));
  for (const q of queued) shown.push(item(`queued-${q.id}`, { kind: "queued", queued: q }, q.content, "user"));

  // Stop: the answer ends on the server with what it wrote so far, and comes back as the turn polled
  // above (code `stopped`). One waiting for an owner's approval is answered there instead.
  const stop = async () => {
    if (!running) return;
    const res = await stopAgentChatAction(workspaceId, agentId, running).catch(() => null);
    if (res && !res.ok) setError(res.error);
  };

  const chat: ThreadChat = {
    workspaceId,
    conversationId,
    messages: shown,
    status: null,
    error,
    input,
    setInput,
    inputRef,
    running: running !== null,
    stop: running && turn?.status !== "awaiting_approval" ? () => void stop() : undefined,
    files: files.map((f) => ({ id: f.name, name: f.name, contentType: "text/plain", size: f.size, url: "" })),
    attachFiles: attach,
    removeFile: (name: string) => setFiles((list) => list.filter((f) => f.name !== name)),
    queued: NO_QUEUE,
    clearQueue: noop,
    pending: null,
    decide: decideNothing,
    reasoning: NO_REASONING,
    fileAccept: AGENT_CHAT_FILE_ACCEPT,
    takesFile: (file: File) => agentChatFileType(file.name, file.type) !== null,
    maxLength: MAX_AGENT_CHAT_MESSAGE,
    sending,
    askAgain: redoable,
    editKey: lastQuestion ? questionKey(lastQuestion) : null,
  };

  return {
    info,
    loadFailed,
    load,
    state,
    canChat,
    blocked,
    chat,
    send,
    redo,
    messages,
    runs,
    connections,
    running,
    arrived,
    turn: shownTurn,
    redoRun,
    conversationId,
    summarizing,
    open,
    remove,
    summarize,
    unqueue,
    undoCorrection,
    refreshRuns,
    setMessages,
  };
}

export type AgentChatModel = ReturnType<typeof useAgentChat>;
