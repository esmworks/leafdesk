"use client";

/**
 * The Agent block's card (lib/agent-block.ts, components/page/agent-block.tsx): the agent's name,
 * a box to ask it and the latest answer in this reader's conversation for the page, which the
 * answer streams into as the agent's run writes it (use-agent-chat.ts). *Open chat* swaps the card
 * for the block's full chat (agent-thread.tsx) on the very same conversations. Loaded only where
 * such a block is shown.
 */
import { ArrowUp, Loader2, MessageSquare, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AnswerText } from "@/components/ai-chat/answer-text";
import { lazyPart } from "@/components/lazy-part";
import { AgentIcon } from "@/components/settings/agent-dialog";
import { Button, cn } from "@/components/ui";
import { chatFailure, type ChatPlace } from "@/lib/agent-chat";
import { agentPagePath } from "@/lib/agent-page";
import { useAgentChat, type AgentItem } from "./use-agent-chat";

const AgentChat = lazyPart(() => import("./agent-thread").then((m) => m.AgentChat), <div aria-busy="true" className="my-1 h-24 w-full animate-pulse rounded-lg bg-bg-subtle" />);

const NO_SOURCES = new Map();
const noop = () => {};

export function AgentCard({ workspaceId, agentId, place }: { workspaceId: string; agentId: string; place: NonNullable<ChatPlace> }) {
  const t = useTranslations("page.agentBlock");
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="my-1 w-full">
        <div className="mb-1 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            <X className="h-3.5 w-3.5" aria-hidden />
            {t("closeChat")}
          </Button>
        </div>
        <AgentChat workspaceId={workspaceId} agentId={agentId} place={place} variant="block" />
      </div>
    );
  }
  return <AskBox workspaceId={workspaceId} agentId={agentId} place={place} onOpenChat={() => setOpen(true)} />;
}

/** The card's own frame: the page's editor around the block never sees its keys, pastes or dropped files. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="my-1 w-full rounded-lg border border-border bg-bg"
      onKeyDown={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
      onDragOver={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function AskBox({ workspaceId, agentId, place, onOpenChat }: { workspaceId: string; agentId: string; place: NonNullable<ChatPlace>; onOpenChat: () => void }) {
  const t = useTranslations("page.agentBlock");
  const tc = useTranslations("page.agentChat");
  const model = useAgentChat({ workspaceId, agentId, place });
  const { info, state, running, messages, canChat, blocked, chat } = model;

  if (model.loadFailed) {
    return (
      <Frame>
        <p role="alert" className="px-3 py-3 text-sm text-fg-muted">
          {tc("loadFailed")}{" "}
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => void model.load()}>
            {tc("retry")}
          </button>
        </p>
      </Frame>
    );
  }
  if (!info) {
    return (
      <Frame>
        <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />
      </Frame>
    );
  }
  if (state === "viaManager" && info.agent) {
    const manager = info.manager;
    return (
      <Frame>
        <div className="flex items-start gap-2 px-3 py-3 text-sm text-fg-muted" data-agent-block-state={state}>
          <AgentIcon icon={info.agent.icon} />
          <p>
            {manager ? tc("states.viaManager", { name: info.agent.name, manager: manager.name }) : tc("states.viaManagerGone", { name: info.agent.name })}{" "}
            {manager && (
              <Link href={agentPagePath(workspaceId, manager.id)} className="text-accent hover:underline">
                {tc("chatWithManager", { manager: manager.name })}
              </Link>
            )}
          </p>
        </div>
      </Frame>
    );
  }
  if (!info.agent || state === "guest" || state === "gone" || state === "noAccess") {
    return (
      <Frame>
        <p className="flex items-center gap-2 px-3 py-3 text-sm text-fg-muted" data-agent-block-state={state}>
          <AgentIcon icon={null} />
          {tc(`states.${state === "guest" || state === "noAccess" ? state : "gone"}`)}
        </p>
      </Frame>
    );
  }

  const agent = info.agent;
  const asked = messages.findLast((m) => m.role === "user");
  const answer = messages.findLast((m) => m.role === "assistant" && !m.summary);
  // The answer under way, as it is written.
  const live = running ? chat.messages.findLast((m) => (m.item as AgentItem | undefined)?.kind === "live") : undefined;
  const text = running ? (live?.content ?? "") : (answer?.content ?? "");
  const waiting = model.turn?.status === "awaiting_approval";
  const busy = Boolean(running) || chat.sending;
  const disabled = !canChat || Boolean(blocked) || busy;
  const ask = () => {
    if (!disabled && chat.input.trim()) void model.send();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
    }
  };

  return (
    <Frame>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2" data-agent-block-state={state}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-hover text-sm">
          <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
        {state === "readOnly" && (
          <span className="shrink-0 rounded border border-border px-1.5 text-xs text-fg-muted" title={tc("readOnlyHint")}>
            {tc("readOnly")}
          </span>
        )}
        <Button size="sm" variant="ghost" onPointerEnter={() => void AgentChat.preload()} onClick={onOpenChat}>
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          {t("openChat")}
        </Button>
      </div>
      <div className="px-3 py-2.5 text-sm" aria-live="polite">
        {asked && <p className="mb-1.5 line-clamp-2 break-words text-xs text-fg-muted">{t("youAsked", { question: asked.content })}</p>}
        {text ? (
          <div className="break-words">
            <AnswerText text={text} sources={NO_SOURCES} onSource={noop} writing={Boolean(running)} />
          </div>
        ) : running ? (
          <p className="flex items-center gap-2 text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {tc("working")}
          </p>
        ) : !answer ? (
          <p className="text-fg-muted">{blocked ?? tc(`empty.${state === "full" ? "full" : "readOnly"}`, { name: agent.name })}</p>
        ) : null}
        {running && text && (
          <p className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {tc("working")}
          </p>
        )}
        {waiting && <p className="mt-1.5 text-xs text-fg-muted">{t("awaitingApproval")}</p>}
        {!running && answer?.code && <p className={cn("mt-1 text-xs", answer.code === "stopped" ? "text-fg-muted" : "text-danger")}>{tc(`failed.${chatFailure(answer.code)}`)}</p>}
        {blocked && answer && <p className="mt-1.5 text-xs text-fg-muted">{blocked}</p>}
        {chat.error && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {chat.error}
          </p>
        )}
      </div>
      <div className="flex items-end gap-2 border-t border-border px-3 py-2">
        <textarea
          rows={1}
          value={chat.input}
          maxLength={chat.maxLength}
          disabled={!canChat || Boolean(blocked)}
          onChange={(e) => chat.setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={t("placeholder", { name: agent.name })}
          aria-label={t("placeholder", { name: agent.name })}
          className="max-h-32 min-h-8 min-w-0 flex-1 resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm outline-none [field-sizing:content] placeholder:text-fg-faint focus:border-accent disabled:opacity-60"
        />
        {running && chat.stop ? (
          <Button size="sm" onClick={chat.stop}>
            {t("stop")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={disabled || !chat.input.trim()} onClick={ask}>
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            {t("ask")}
          </Button>
        )}
      </div>
    </Frame>
  );
}
