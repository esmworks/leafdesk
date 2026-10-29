"use client";

/**
 * A chat with an agent (see lib/agent-chat.ts), on its own page, in its dialog's Chat tab and in a
 * page's block, with the box to write in. Each message is one of the agent's runs, done by its
 * worker: the chat follows the run (its steps as they come, then its answer) by asking for it again
 * every second, and for the owner whose turn it is, shows the call it waits on to approve. On the
 * agent's page and in its dialog it is one chat that goes on (`AgentChatThread`), where the runs
 * the person started otherwise (schedules, tasks, mentions) come in as the agent speaking up, asked
 * for again as they go on; a block keeps conversations to pick from. Loaded only where a chat is shown.
 */
import { ArrowUp, AtSign, ChevronRight, Clock, ListChecks, Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  agentChatInfoAction,
  agentChatTurnAction,
  agentThreadAction,
  agentThreadRunsAction,
  deleteAgentConversationAction,
  getAgentConversationAction,
  sendAgentChatAction,
} from "@/app/actions/agent-chat";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { AgentIcon, AgentStepLine } from "@/components/settings/agent-dialog";
import { cn, IconButton, selectClass } from "@/components/ui";
import {
  chatFailure,
  MAX_AGENT_CHAT_MESSAGE,
  type AgentChatInfo,
  type AgentChatMessageView,
  type AgentChatRunView,
  type AgentChatStepView,
  type AgentChatTurn,
  type ChatPlace,
} from "@/lib/agent-chat";

// The answer's Markdown renderer is the AI chat's, loaded with the first answer shown.
const AnswerMarkdown = lazy(() => import("@/components/ai-chat/answer-markdown"));
const NO_SOURCES = new Map();
const noop = () => {};
/** How often a turn under way is asked for. */
const POLL_MS = 1_000;
/** How often the agent's own chat asks for its runs again: while one goes on, and otherwise. */
const RUNS_BUSY_MS = 3_000;
const RUNS_IDLE_MS = 30_000;
const runGoesOn = (r: AgentChatRunView) => r.status === "pending" || r.status === "running" || r.status === "awaiting_approval";

export function AgentChat({
  workspaceId,
  agentId,
  place,
  variant,
  focusRun = null,
}: {
  workspaceId: string;
  agentId: string;
  place: ChatPlace;
  variant: "page" | "dialog" | "block";
  /** One of the agent's own chat's runs to bring into view once it loads, instead of the end (a report opened from the inbox). */
  focusRun?: string | null;
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
  const [turn, setTurn] = useState<AgentChatTurn | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chatId = place?.chatId ?? null;
  const pageId = place?.pageId ?? null;
  // The place as a stable value for the effects (a new object on every render of the block).
  const placeRef = useRef(place);
  placeRef.current = place;
  const thread = place === null;

  const openThread = useCallback(async () => {
    setError(null);
    setTurn(null);
    const res = await agentThreadAction(workspaceId, agentId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConversationId(res.data.conversationId);
    setMessages(res.data.messages);
    setRuns(res.data.runs);
    setConnections(res.data.connections);
    setRunning(res.data.running);
  }, [workspaceId, agentId]);

  const refreshRuns = useCallback(async () => {
    const res = await agentThreadRunsAction(workspaceId, agentId).catch(() => null);
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
        return;
      }
      const res = await getAgentConversationAction(workspaceId, agentId, id, placeRef.current);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConversationId(res.data.id);
      setMessages(res.data.messages);
      setConnections(res.data.connections);
      setRunning(res.data.running);
    },
    [workspaceId, agentId],
  );

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await agentChatInfoAction(workspaceId, agentId, placeRef.current);
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setInfo(res.data);
      // Back where they were: the agent's own chat, or a block's latest conversation.
      if (placeRef.current === null) {
        if (res.data.agent) await openThread();
      } else await open(res.data.conversations[0]?.id ?? null);
    } catch {
      setLoadFailed(true);
    }
  }, [workspaceId, agentId, open, openThread]);

  useEffect(() => {
    void load();
    // chatId and pageId stand for the place: another block's chat loads again.
  }, [load, chatId, pageId]);

  // A turn under way: asked for every second until its run ends, then its answer joins the messages.
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await agentChatTurnAction(workspaceId, running).catch(() => null);
      if (!live) return;
      if (res?.ok) {
        setTurn(res.data);
        setConnections((c) => ({ ...c, ...res.data.connections }));
        if (res.data.status === "done" || res.data.status === "failed") {
          const ended = res.data;
          setMessages((list) => [
            ...list,
            { role: "assistant", content: ended.answer, runId: ended.runId, code: ended.status === "failed" ? (ended.code ?? "error") : null, steps: ended.steps, at: new Date().toISOString() },
          ]);
          setTurn(null);
          setRunning(null);
          return;
        }
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [running, workspaceId]);

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

  const state = info?.state;
  const canChat = state === "full" || state === "readOnly";

  const send = async () => {
    const message = input.trim();
    if (!message || !info?.agent || !canChat || running || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendAgentChatAction({ workspaceId, agentId, place: placeRef.current, conversationId, message });
      if (!res.ok) {
        setError(res.error);
        // The chat's standing changed (the agent paused or gone, the month's tokens used up…).
        if (res.code && ["guest", "gone", "noAccess", "paused", "aiOff", "limitReached"].includes(res.code)) void agentChatInfoAction(workspaceId, agentId, placeRef.current).then((r) => r.ok && setInfo(r.data));
        return;
      }
      const { conversation, runId } = res.data;
      setInput("");
      setConversationId(conversation.id);
      setMessages((list) => [...list, { role: "user", content: message, runId, code: null, steps: [], at: new Date().toISOString() }]);
      setRunning(runId);
      setInfo((current) => current && { ...current, conversations: [conversation, ...current.conversations.filter((c) => c.id !== conversation.id)] });
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

  const openPage = (id: string) => router.push(`/w/${workspaceId}/p/${id}`);
  const block = variant === "block";
  const page = variant === "page";

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

  return (
    <Frame block={block}>
      {/* The block always names its agent and keeps conversations; the agent's own chat is one, its row only says it's read-only. */}
      {(block || state === "readOnly") && (
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
          {block && (
            <div className="ms-auto flex min-w-0 items-center gap-0.5">
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

      <div ref={listRef} className={cn(page ? "min-h-24 scroll-mb-28 py-4" : "overflow-y-auto", block ? "max-h-[28rem] px-3 py-3" : !page && "max-h-[45vh] py-2")} aria-live="polite">
        {messages.length === 0 && runs.length === 0 ? (
          <p className="text-sm text-fg-muted">{t(`empty.${state === "full" ? (thread ? "thread" : "full") : "readOnly"}`, { name: agent.name })}</p>
        ) : (
          <ol className="space-y-3">
            {timeline(messages, runs, thread).map((item) =>
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
                  <RunMessage workspaceId={workspaceId} run={item.run} connections={connections} onOpen={openPage} onAnswered={() => void refreshRuns()} />
                </li>
              ) : (
                <li key={`${item.message.role}-${item.message.runId}`}>
                  {item.message.role === "user" ? (
                    <div className="flex justify-end">
                      <p className="max-w-[85%] rounded-xl bg-bg-hover px-3 py-1.5 text-sm break-words whitespace-pre-wrap">{item.message.content}</p>
                    </div>
                  ) : (
                    <Answer message={item.message} connections={connections} onOpen={openPage} />
                  )}
                </li>
              ),
            )}
            {running && (
              <li className="space-y-1.5">
                {turn && turn.steps.length > 0 && <StepList steps={turn.steps} connections={connections} onOpen={openPage} />}
                {waiting ? (
                  <div className="rounded-lg border border-border p-3">
                    <p className="mb-1.5 text-sm">{t("approval")}</p>
                    <ApprovalActions workspaceId={workspaceId} approval={{ runId: turn!.runId, ...waiting }} onAnswered={noop} />
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-sm text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    {/* A call only an owner answers: the person chatting sees that it waits. */}
                    {turn?.status === "pending" ? t("waiting") : turn?.status === "awaiting_approval" ? t("awaitingOwner") : t("working")}
                  </p>
                )}
              </li>
            )}
          </ol>
        )}
      </div>

      <div className={cn(block ? "border-t border-border px-3 py-2" : page ? "sticky bottom-0 bg-bg pb-6" : "pt-2")}>
        {(blocked || error) && (
          <p role={error ? "alert" : "status"} className={cn("mb-1.5 text-xs", error ? "text-danger" : "text-fg-muted")}>
            {error ?? blocked}
          </p>
        )}
        <form
          className={cn("flex items-end gap-2", page && "rounded-xl border border-border bg-bg px-3 py-2 shadow-sm")}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
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
            className="min-h-8 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-fg-faint disabled:opacity-60"
          />
          <button
            type="submit"
            aria-label={t("send")}
            title={t("send")}
            disabled={!canChat || !input.trim() || Boolean(running) || sending}
            className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fg text-bg transition-colors hover:bg-fg/85 disabled:bg-bg-active disabled:text-fg-faint"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
          </button>
        </form>
      </div>
    </Frame>
  );
}

/** The block's box; the dialog's tab has its own. */
function Frame({ block, children }: { block: boolean; children: React.ReactNode }) {
  return block ? <div className="my-1 w-full rounded-lg border border-border bg-bg">{children}</div> : <div>{children}</div>;
}

/** An answer: the steps taken to it (folded), then what the agent said, or why it couldn't answer. */
function Answer({ message, connections, onOpen }: { message: AgentChatMessageView; connections: Record<string, string>; onOpen: (pageId: string) => void }) {
  const t = useTranslations("page.agentChat");
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1 text-sm">
      {message.steps.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 rounded text-xs text-fg-muted hover:text-fg"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
            {t("steps", { count: message.steps.length })}
          </button>
          {open && <StepList steps={message.steps} connections={connections} onOpen={onOpen} />}
        </div>
      )}
      {message.content.trim() && (
        <div className="break-words">
          <Suspense fallback={<p className="whitespace-pre-wrap">{message.content}</p>}>
            <AnswerMarkdown text={message.content} sources={NO_SOURCES} onSource={noop} />
          </Suspense>
        </div>
      )}
      {message.code && <p className="text-xs text-danger">{t(`failed.${chatFailure(message.code)}`)}</p>}
    </div>
  );
}

function StepList({ steps, connections, onOpen }: { steps: AgentChatStepView[]; connections: Record<string, string>; onOpen: (pageId: string) => void }) {
  return (
    <ol className="ms-1.5 mt-1 space-y-1 border-s border-border ps-3 text-xs text-fg-muted">
      {steps.map((step, i) => (
        <li key={i} className="flex min-w-0 items-start gap-1.5">
          <AgentStepLine step={step} connections={connections} onOpen={onOpen} />
        </li>
      ))}
    </ol>
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
  for (const run of runs) units.push([{ at: run.at, run }]);
  const items = units.sort((a, b) => a[0].at.localeCompare(b[0].at)).flat();
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
  onOpen,
  onAnswered,
}: {
  workspaceId: string;
  run: AgentChatRunView;
  connections: Record<string, string>;
  onOpen: (pageId: string) => void;
  onAnswered: () => void;
}) {
  const t = useTranslations("page.agentChat");
  const format = useFormatter();
  // The agent's own chat marks each day: the time is enough.
  const when = format.dateTime(new Date(run.at), { hour: "2-digit", minute: "2-digit" });
  const Icon = run.kind === "schedule" ? Clock : run.kind === "mention" ? AtSign : ListChecks;
  const from = run.label ? t(`from.${run.kind}On`, { place: run.label }) : t(`from.${run.kind}`);
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
        <Answer message={{ role: "assistant", content: run.answer, runId: run.id, code: run.status === "failed" ? (run.code ?? "error") : null, steps: run.steps, at: run.at }} connections={connections} onOpen={onOpen} />
      ) : (
        <>
          {run.steps.length > 0 && <StepList steps={run.steps} connections={connections} onOpen={onOpen} />}
          {run.pending ? (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-1.5 text-sm">{t("approval")}</p>
              <ApprovalActions workspaceId={workspaceId} approval={{ runId: run.id, ...run.pending }} onAnswered={onAnswered} />
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {run.status === "pending" ? t("waiting") : run.status === "awaiting_approval" ? t("awaitingOwner") : t("working")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
