"use client";

/**
 * A chat with an agent (use-agent-chat.ts), on its own page, in its dialog's Chat tab and in a
 * page's block: the AI chat's thread and box (ChatThread), with the agent's own items in it
 * (agent-items.tsx) and its own tools around it: searching the person's conversations with the
 * agent (chat-search.tsx, loaded when opened), going on as a new conversation from a summary, and in
 * a block, its conversations to pick from. On the agent's page, its runs and what they changed go
 * in the boxes beside the chat. Loaded only where a chat is shown.
 */
import { Check, Loader2, Plus, ScrollText, Search, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAiChat } from "@/components/ai-chat/chat-panel";
import { ChangedPagesBox, changedPages } from "@/components/ai-chat/chat-side";
import { ChatThread } from "@/components/ai-chat/chat-thread";
import type { ChatMessage } from "@/components/ai-chat/use-chat";
import { lazyPart } from "@/components/lazy-part";
import { AgentIcon } from "@/components/settings/agent-dialog";
import { SideBox, SideItem } from "@/components/side-box";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { cn, IconButton, selectClass } from "@/components/ui";
import type { AgentChatMessageView, AgentChatRunView, AgentChatSearchHit, ChatPlace } from "@/lib/agent-chat";
import { SIDE_COLUMN, SIDE_CONTAINER, SIDE_PAD, SIDE_SHOWN } from "@/lib/side-layout";
import { AgentThreadItem, type ItemContext } from "./agent-items";
import { openedAt, runGoesOn, useAgentChat, type AgentItem } from "./use-agent-chat";

const ChatSearch = lazyPart(() => import("./chat-search").then((m) => m.ChatSearch));
const ComputerNote = lazyPart(() => import("./computer-note").then((m) => m.ComputerNote));

/** How long an item brought into view stays marked. */
const MARK_MS = 2_500;

export function AgentChat({
  workspaceId,
  agentId,
  place,
  variant,
  focusRun = null,
  header = null,
  aside = null,
}: {
  workspaceId: string;
  agentId: string;
  place: ChatPlace;
  variant: "page" | "dialog" | "block";
  /** One of the agent's own chat's runs to bring into view once it loads, instead of the end (a report opened from the inbox). */
  focusRun?: string | null;
  /** The agent's page: who it is, above the messages (on a narrow page). */
  header?: ReactNode;
  /** The agent's page: its boxes beside the chat on a wide page, above the chat's own (its runs, what they changed). */
  aside?: ReactNode;
}) {
  const t = useTranslations("page.agentChat");
  const router = useRouter();
  const model = useAgentChat({ workspaceId, agentId, place });
  const { info, state } = model;
  const voice = useAiChat()?.voice ?? null;
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const thread = place === null;
  const chatId = place?.chatId ?? null;
  const page = variant === "page";
  const block = variant === "block";

  // The run to bring into view (marked for a moment): kept there while the chat loads, again too,
  // until something new comes in (a message, a run under way, another run). `runs`: how many runs
  // there were when it came into view.
  const focusRef = useRef<{ id: string; runs: number | null } | null>(focusRun ? { id: focusRun, runs: null } : null);
  // A message to bring into view (a search hit), by when it was written.
  const focusAt = useRef<string | null>(openedAt().at);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const at = focusAt.current;
    if (at && model.messages.length > 0) {
      focusAt.current = null;
      const item = el.querySelector<HTMLElement>(`[data-at="${CSS.escape(at)}"], [data-turn$="-${CSS.escape(at)}"]`);
      if (item) {
        mark(item);
        item.scrollIntoView({ block: "center" });
        return;
      }
    }
    const focus = focusRef.current;
    if (focus && (model.messages.length > 0 || model.runs.length > 0)) {
      // One of the latest runs only (THREAD_RUNS); an older one leaves the chat at its end.
      const item = el.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(focus.id)}"]`);
      if (item && !model.running && (focus.runs === null || focus.runs === model.runs.length)) {
        if (focus.runs === null) mark(item);
        focus.runs = model.runs.length;
        item.scrollIntoView({ block: "start" });
        return;
      }
      focusRef.current = null;
    }
  }, [model.messages, model.runs.length, model.running]);

  const openPage = (id: string) => router.push(`/w/${workspaceId}/p/${id}`);

  // A search hit: its message here when this place holds it, else the place that does.
  const pick = async (hit: AgentChatSearchHit) => {
    setSearching(false);
    if (hit.chatId === chatId) {
      if (!thread && hit.conversationId !== model.conversationId) await model.open(hit.conversationId);
      focusAt.current = hit.at;
      // The focus effect runs as the messages change; it is asked to run now for the same ones.
      model.setMessages((list) => [...list]);
      return;
    }
    if (hit.chatId === null) return router.push(`/w/${workspaceId}/agents/${agentId}?at=${encodeURIComponent(hit.at)}`);
    if (hit.pageId) router.push(`/w/${workspaceId}/p/${hit.pageId}?agentChat=${encodeURIComponent(hit.conversationId)}&at=${encodeURIComponent(hit.at)}`);
  };

  if (model.loadFailed) {
    return (
      <Frame block={block}>
        <p role="alert" className="px-3 py-3 text-sm text-fg-muted">
          {t("loadFailed")}{" "}
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => void model.load()}>
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
  const { conversationId, messages, running, canChat } = model;
  const busy = Boolean(running) || model.chat.messages.some((m) => (m.item as AgentItem | undefined)?.kind === "queued");
  const askedAt = new Map<string, string>();
  for (const m of messages) if (m.role === "user" && !askedAt.has(m.runId)) askedAt.set(m.runId, m.at);
  const context: ItemContext = {
    workspaceId,
    agentName: agent.name,
    connections: model.connections,
    arrived: model.arrived,
    turn: model.turn,
    approves: state === "full",
    askedAt,
    redoRun: model.redoRun,
    onOpen: openPage,
    onRedo: () => void model.redo(null),
    onUndo: model.undoCorrection,
    onUnqueue: (id) => void model.unqueue(id),
    onRunAnswered: () => void model.refreshRuns(),
  };
  const renderItem = (message: ChatMessage, _index: number, last: boolean) => (
    <AgentThreadItem item={message.item as AgentItem} text={message.content} last={last && !running} page={page} context={context} />
  );

  const tools = (
    <>
      {state === "readOnly" && (
        <span className="shrink-0 rounded border border-border px-1.5 text-xs text-fg-muted" title={t("readOnlyHint")}>
          {t("readOnly")}
        </span>
      )}
      <IconButton label={t("search.open")} title={t("search.open")} className="h-7 w-7" onPointerEnter={() => void ChatSearch.preload()} onClick={() => setSearching((on) => !on)}>
        <Search className="h-3.5 w-3.5" />
      </IconButton>
      {canChat && conversationId && messages.length > 0 && (
        <IconButton label={t("newWithSummary")} title={t("newWithSummary")} className="h-7 w-7" disabled={busy || model.summarizing} onClick={() => void model.summarize()}>
          {model.summarizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScrollText className="h-3.5 w-3.5" />}
        </IconButton>
      )}
    </>
  );
  const search = searching && <ChatSearch workspaceId={workspaceId} agentId={agentId} agentName={agent.name} onPick={(hit) => void pick(hit)} onClose={() => setSearching(false)} />;
  const chat = (
    <ChatThread
      chat={model.chat}
      blocked={model.blocked}
      onSend={(again) => void (again ? model.redo(again.question) : model.send())}
      onSource={(source) => source.pageId && openPage(source.pageId)}
      variant={page ? "page" : "box"}
      voice={voice}
      autoFocus={page}
      placeholder={t("placeholder", { name: agent.name })}
      empty={t(`empty.${state === "full" ? (thread ? "thread" : "full") : "readOnly"}`, { name: agent.name })}
      header={header}
      above={info.computer && <ComputerNote folders={info.computer} />}
      renderItem={renderItem}
    />
  );

  if (page) {
    return (
      <div ref={containerRef} className={cn(SIDE_CONTAINER, "h-full")}>
        <div className={cn("flex h-full flex-col", SIDE_PAD)}>
          <div data-window-controls-clear className="flex h-11 shrink-0 items-center gap-1 px-3 max-md:ps-1.5">
            <SidebarOpenButton className="me-1 max-md:me-0" />
            <div className="ms-auto flex items-center gap-0.5">{tools}</div>
          </div>
          {search && <div className="mx-auto w-full max-w-3xl px-4">{search}</div>}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {chat}
            <aside aria-label={t("side.label", { name: agent.name })} className={cn(SIDE_SHOWN, "pointer-events-none absolute inset-y-0 end-0 pe-4 pt-2 pb-4")}>
              <div className={cn(SIDE_COLUMN, "pointer-events-auto flex max-h-full overflow-y-auto")}>
                {aside}
                <SideBoxes messages={messages} runs={model.runs} onRun={(id) => focusRunNow(containerRef.current, id)} onOpen={openPage} />
              </div>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Frame block={block}>
      {/* The page's editor around a block never sees the chat's keys, pastes or dropped files. */}
      <div
        ref={containerRef}
        className={cn("flex min-h-0 flex-col", block ? "max-h-[34rem]" : "max-h-[calc(45vh+10rem)]")}
        onKeyDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onDrop={(e) => e.stopPropagation()}
        onDragOver={(e) => e.stopPropagation()}
      >
        {/* The block names its agent and keeps conversations; the dialog's chat is the agent's own. */}
        <div className={cn("flex shrink-0 items-center gap-2", block ? "border-b border-border px-3 py-2" : "pb-1")}>
          {block && (
            <>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-hover text-sm">
                <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
            </>
          )}
          <div className="ms-auto flex min-w-0 items-center gap-0.5">
            {tools}
            {block && info.conversations.length > 0 && (
              <select
                aria-label={t("conversations")}
                className={cn(selectClass, "h-7 max-w-44 min-w-0 truncate text-xs")}
                value={conversationId ?? ""}
                disabled={Boolean(running)}
                onChange={(e) => void model.open(e.target.value || null)}
              >
                {!conversationId && <option value="">{t("newConversation")}</option>}
                {info.conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            {block && (
              <IconButton label={t("newConversation")} title={t("newConversation")} className="h-7 w-7" disabled={Boolean(running) || !conversationId} onClick={() => void model.open(null)}>
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            )}
            {block && conversationId && (
              <IconButton label={t("deleteConversation")} title={t("deleteConversation")} className="h-7 w-7" disabled={Boolean(running)} onClick={() => void model.remove()}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>
        {search && <div className={cn("shrink-0", block && "px-3 pt-2")}>{search}</div>}
        {chat}
      </div>
    </Frame>
  );
}

/** Marks an item brought into view for a moment (its list item, as far as it reaches). */
function mark(item: HTMLElement) {
  const target = item.closest("li") ?? item;
  target.classList.add("rounded-lg", "transition-colors", "duration-700", "bg-bg-hover");
  setTimeout(() => target.classList.remove("bg-bg-hover"), MARK_MS);
}

/** A run of the boxes beside the agent's page, brought into view in the chat. */
function focusRunNow(container: HTMLElement | null, id: string) {
  const item = container?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(id)}"]`);
  if (!item) return;
  mark(item);
  item.scrollIntoView({ block: "start" });
}

/** Runs the boxes beside the agent's page list at most, the latest. */
const SIDE_RUNS = 10;

/**
 * The agent's page's boxes from its chat: the person's runs other than chats (one brings it into
 * view in the chat), and the pages the runs and the answers made or changed.
 */
function SideBoxes({ messages, runs, onRun, onOpen }: { messages: AgentChatMessageView[]; runs: AgentChatRunView[]; onRun: (id: string) => void; onOpen: (pageId: string) => void }) {
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
function Frame({ block, children }: { block: boolean; children: ReactNode }) {
  return block ? <div className="my-1 w-full rounded-lg border border-border bg-bg">{children}</div> : <>{children}</>;
}
