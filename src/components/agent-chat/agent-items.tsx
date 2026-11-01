"use client";

/**
 * What an agent's chat shows in ChatThread besides the questions (use-agent-chat.ts `AgentItem`):
 * its answers, with the steps its run took (folded into how long it took), the call it waits on for
 * the owner to approve, the changes it proposed and the files it attached; the runs the person
 * started otherwise, as the agent speaking up (a quiet one as one muted line); where each day
 * starts; the summary a conversation started from; and the messages waiting for the answer under
 * way, each removable. Loaded only where an agent's chat is shown.
 */
import { AtSign, ChevronRight, Clock, ListChecks, Loader2, Mail, RotateCcw, ScrollText, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import type { ChatMemoryRecord } from "@/db/schema/ai";
import { AnswerText } from "@/components/ai-chat/answer-text";
import { AttachmentChip } from "@/components/ai-chat/attachment-chip";
import { CopyAction, questionBox, revealed, StepsFold } from "@/components/ai-chat/message-parts";
import { StepLine } from "@/components/ai-chat/step-line";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { lazyPart } from "@/components/lazy-part";
import { AgentStepLine } from "@/components/settings/agent-dialog";
import { Button, cn, IconButton } from "@/components/ui";
import { chatFailure, type AgentChatMessageView, type AgentChatQueuedView, type AgentChatRunView, type AgentChatStepView, type AgentChatTurn } from "@/lib/agent-chat";
import { AnswerFiles } from "./chat-files";
import type { AgentItem } from "./use-agent-chat";

const RunProposals = lazyPart(() => import("./run-proposals").then((m) => m.RunProposals));

const NO_SOURCES = new Map();
const noop = () => {};

export type ItemContext = {
  workspaceId: string;
  agentName: string;
  connections: Record<string, string>;
  /** The run whose answer came while the chat was open: its text flows in. */
  arrived: string | null;
  /** The turn under way, as last asked for, and whether the person may approve its call. */
  turn: AgentChatTurn | null;
  approves: boolean;
  /** When each run's first question was asked (for the running clock). */
  askedAt: Map<string, string>;
  redoRun: string | null;
  onOpen: (pageId: string) => void;
  onRedo: () => void;
  onUndo: (runId: string, memoryId: string, index: number) => Promise<string | null>;
  onUnqueue: (id: string) => void;
  onRunAnswered: () => void;
};

/**
 * The item in a message's place; `text`: the message's (an answer under way: what it wrote so far);
 * `last`: the conversation's latest (its actions show without hovering).
 */
export function AgentThreadItem({ item, text, last, page, context }: { item: AgentItem; text: string; last: boolean; page: boolean; context: ItemContext }) {
  switch (item.kind) {
    case "day":
      return (
        <p className="pt-2 text-center text-xs text-fg-muted">
          <DayLabel at={item.at} />
        </p>
      );
    case "summary":
      return <SummaryNote message={item.message} />;
    case "queued":
      return <QueuedQuestion item={item.queued} page={page} name={context.agentName} onRemove={() => context.onUnqueue(item.queued.id)} />;
    case "run":
      return (
        <div data-run-id={item.run.id} className="scroll-mt-20">
          <RunMessage run={item.run} last={last} context={context} />
        </div>
      );
    case "answer":
      return (
        <div data-at={item.message.at}>
          <Answer
            message={item.message}
            ms={item.ms}
            last={last}
            arrived={item.message.runId === context.arrived}
            context={context}
            onRedo={item.message.runId === context.redoRun ? context.onRedo : undefined}
            onUndo={(memoryId, index) => context.onUndo(item.message.runId, memoryId, index)}
          />
        </div>
      );
    case "live": {
      const { turn } = context;
      return (
        <>
          <Answer
            message={{ role: "assistant", content: text, runId: item.runId, code: null, steps: turn?.steps ?? [], at: "" }}
            ms={undefined}
            last={false}
            arrived
            context={context}
            live={{ status: turn?.status ?? "pending", pending: turn?.pending && context.approves ? turn.pending : null, deferredUntil: turn?.deferredUntil ?? null, startedAt: context.askedAt.get(item.runId) }}
          />
          {turn && turn.attached.length > 0 && <AnswerFiles files={turn.attached} />}
        </>
      );
    }
  }
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

/** A message waiting for the answer under way: marked so, and taken out with its button. */
function QueuedQuestion({ item, page, name, onRemove }: { item: AgentChatQueuedView; page: boolean; name: string; onRemove: () => void }) {
  const t = useTranslations("page.agentChat");
  return (
    <div className="opacity-70" data-queued={item.id}>
      {item.files.length > 0 && (
        <div className={cn("mb-1 flex flex-wrap gap-1.5", page ? "justify-end" : "ms-8")}>
          {item.files.map((f) => (
            <AttachmentChip key={f.name} file={{ id: f.name, name: f.name, contentType: "text/plain", size: f.size, url: "" }} />
          ))}
        </div>
      )}
      {item.content && <div className={cn(questionBox(page), "border border-dashed border-border bg-transparent")}>{item.content}</div>}
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

/**
 * An answer: the steps taken to it (folded into how long it took), then what the agent said, or
 * why it couldn't answer, and copying it (on hover, but for the latest). One under way (`live`)
 * has its steps open under a running clock, with what it waits on last, then what it has written
 * so far; for the owner whose turn it is, the call to approve. It stays the same answer once it
 * ends, so its text goes on flowing from where it was.
 */
function Answer({
  message,
  ms,
  last,
  arrived = false,
  context,
  onRedo,
  onUndo,
  live = null,
}: {
  message: AgentChatMessageView;
  ms: number | undefined;
  last: boolean;
  /** Being written, or came while the chat was open: its text flows in. */
  arrived?: boolean;
  context: ItemContext;
  /** The last answer, done again (Regenerate). */
  onRedo?: () => void;
  /** Takes back a correction this answer's run kept (once it ended; `index`: its step's): null when it was, else why not. */
  onUndo?: (memoryId: string, index: number) => Promise<string | null>;
  live?: { status: AgentChatRunView["status"]; pending: AgentChatTurn["pending"]; deferredUntil?: string | null; startedAt: string | undefined; onAnswered?: () => void } | null;
}) {
  const t = useTranslations("page.agentChat");
  const format = useFormatter();
  const text = message.content.trim();
  const proposed = !live && message.steps.some((s) => s.kind === "write" && s.outcome === "proposed");
  return (
    <div className="group/answer font-sans text-sm leading-normal">
      {live ? (
        <StepsFold live startedAt={live.startedAt ? Date.parse(live.startedAt) : undefined}>
          <StepItems steps={message.steps} context={context} />
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
            <StepItems steps={message.steps} context={context} onUndo={onUndo} />
          </StepsFold>
        )
      )}
      {live?.pending && (
        <div className="mb-2 rounded-lg border border-border p-3">
          <p className="mb-1.5 text-sm">{live.deferredUntil ? t("deferredApproval", { time: format.dateTime(new Date(live.deferredUntil), { timeStyle: "short" }) }) : t("approval")}</p>
          <ApprovalActions workspaceId={context.workspaceId} approval={{ runId: message.runId, ...live.pending }} onAnswered={live.onAnswered ?? noop} />
        </div>
      )}
      {text && (
        <div className="break-words">
          <AnswerText text={message.content} sources={NO_SOURCES} onSource={noop} writing={arrived} />
        </div>
      )}
      {message.code && <p className="mt-1 text-xs text-danger">{t(`failed.${chatFailure(message.code)}`)}</p>}
      {message.attached && <AnswerFiles files={message.attached} />}
      {proposed && <RunProposals workspaceId={context.workspaceId} runId={message.runId} />}
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

function StepItems({ steps, context, onUndo }: { steps: AgentChatStepView[]; context: ItemContext; onUndo?: (memoryId: string, index: number) => Promise<string | null> }) {
  return steps.map((step, i) => (
    <li key={i} className="flex min-w-0 items-start gap-1.5">
      {onUndo && step.kind === "memory" && step.action === "correct" && step.memoryId && step.outcome !== "undone" ? (
        <CorrectionStepLine step={step} memoryId={step.memoryId} onOpen={context.onOpen} onUndo={(memoryId) => onUndo(memoryId, i)} />
      ) : (
        <AgentStepLine step={step} connections={context.connections} onOpen={context.onOpen} />
      )}
    </li>
  ));
}

/** A correction a chat run kept at once, with Undo (server/agents/memory.ts undoAgentCorrection). */
function CorrectionStepLine({ step, memoryId, onOpen, onUndo }: { step: ChatMemoryRecord; memoryId: string; onOpen: (pageId: string) => void; onUndo: (memoryId: string) => Promise<string | null> }) {
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

function DayLabel({ at }: { at: string }) {
  const format = useFormatter();
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return <time dateTime={at}>{format.dateTime(date, thisYear ? { weekday: "long", day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })}</time>;
}

/** A run the person started otherwise, as the agent speaking up: what started it and when, then as an answer does. */
function RunMessage({ run, last, context }: { run: AgentChatRunView; last: boolean; context: ItemContext }) {
  const t = useTranslations("page.agentChat");
  const format = useFormatter();
  // The agent's own chat marks each day: the time is enough.
  const when = format.dateTime(new Date(run.at), { hour: "2-digit", minute: "2-digit" });
  const Icon = run.kind === "schedule" ? Clock : run.kind === "mention" ? AtSign : run.kind === "mail" ? Mail : ListChecks;
  const from = run.label ? t(`from.${run.kind}On`, { place: run.label }) : t(`from.${run.kind}`);
  if (run.quiet) return <QuietRun run={run} from={from} when={when} context={context} />;
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
          message={{ role: "assistant", content: run.answer, runId: run.id, code: run.status === "failed" ? (run.code ?? "error") : null, steps: run.steps, at: run.at }}
          ms={run.ms ?? undefined}
          last={last}
          context={context}
        />
      ) : (
        <Answer
          message={{ role: "assistant", content: "", runId: run.id, code: null, steps: run.steps, at: run.at }}
          ms={undefined}
          last={false}
          context={context}
          live={{ status: run.status, pending: run.pending, startedAt: run.at, onAnswered: context.onRunAnswered }}
        />
      )}
    </div>
  );
}

/**
 * A schedule's run that found nothing new (finish_run): one muted line, with the reason it gave;
 * the line opens the steps it took, when it took some.
 */
function QuietRun({ run, from, when, context }: { run: AgentChatRunView; from: string; when: string; context: ItemContext }) {
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
        <button type="button" aria-expanded={open} title={title} onClick={() => setOpen(!open)} className="-ms-1 flex max-w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
          {line}
        </button>
      ) : (
        <p className="flex min-w-0 items-center gap-1.5" title={title}>
          {line}
        </p>
      )}
      {open && (
        <ol className="mt-1 ms-1.5 space-y-1 border-s border-border ps-3">
          <StepItems steps={run.steps} context={context} />
        </ol>
      )}
    </div>
  );
}
