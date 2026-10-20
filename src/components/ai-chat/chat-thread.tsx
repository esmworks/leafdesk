"use client";

/**
 * A conversation's messages and the question box, as the panel and the full-page chat show them.
 * Answers render as markdown with their citations (numbered links to the pages, no list of sources
 * below), under the steps taken to them
 * (searches, pages read, changes made): listed as they happen, then folded into how long it took.
 * Under the box, what the chat may change (ask, auto, read only); a change it asks about takes the
 * box's place until the person decides. Questions asked while an answer is on its way wait in a
 * strip above the box.
 */
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  Hand,
  Loader2,
  Pencil,
  RotateCcw,
  ScrollText,
  Square,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BlockChanges } from "@/components/page/history-diff";
import { copyText } from "@/components/settings/copy-button";
import { Button, cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { CHAT_MODES, changedMemory, MAX_CHAT_MESSAGE, type ChatMode, type ChatSourceView, stripCitations } from "@/lib/ai-chat";
import { MemoryDialog } from "./memory-dialog";
import { SkillChip, SkillList, useSkillPicker } from "./skill-picker";
import { PageLink, StepLine } from "./step-line";
import { useReasoning, type ChangeDecision, type Chat, type ChatMessage, type ChatSkillPick, type ChatStatus, type PendingChange, type QueuedQuestion, type Reasoning } from "./use-chat";

export function ChatThread({
  chat,
  blocked,
  onSend,
  onSource,
  footer,
  variant,
}: {
  chat: Chat;
  /** Why questions can't be asked now (offline, AI off), shown above the box. */
  blocked: string | null;
  /** Asks the typed question; with `again`, its question (and skill) in place of the last question and answer. */
  onSend: (again?: { question: string; skill?: ChatSkillPick }) => void;
  onSource: (source: ChatSourceView) => void;
  /** Under the box, before the note (the panel's scope picker). */
  footer?: ReactNode;
  variant: "panel" | "page";
}) {
  const t = useTranslations("ai.chat");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const tSkills = useTranslations("skills.chat");
  const { messages, status, error, input, setInput, running, inputRef } = chat;
  const listRef = useRef<HTMLDivElement>(null);
  const page = variant === "page";
  const skills = useSkillPicker({
    workspaceId: chat.workspaceId,
    input,
    disabled: Boolean(blocked) || chat.skill !== null,
    onPick: (skill) => {
      chat.setSkill(skill);
      setInput("");
      inputRef.current?.focus();
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  // Follow the answer as it streams, unless the person scrolled up to read; an opened conversation
  // starts at its end, and so does a question just asked.
  const shownConversation = useRef(chat.conversationId);
  const shownCount = useRef(messages.length);
  useEffect(() => {
    const el = listRef.current;
    const opened = shownConversation.current !== chat.conversationId;
    const asked = messages.length > shownCount.current && messages[messages.length - 2]?.role === "user";
    shownConversation.current = chat.conversationId;
    shownCount.current = messages.length;
    if (el && (opened || asked || el.scrollHeight - el.scrollTop - el.clientHeight < 120)) el.scrollTop = el.scrollHeight;
  }, [messages, status, chat.conversationId]);

  const send = () => {
    if (!blocked) onSend();
  };
  // The last question can be answered again, or edited, unless its answer changed things (that
  // would make them twice).
  const empty = page && messages.length === 0;
  const round = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors";
  const sendButton = cn(round, "bg-fg text-bg hover:bg-fg/85 disabled:bg-bg-active disabled:text-fg-faint disabled:hover:bg-bg-active");
  const last = messages[messages.length - 1];
  const askAgain =
    !running &&
    !blocked &&
    chat.conversationId !== null &&
    messages.length >= 2 &&
    last.role === "assistant" &&
    !last.steps?.some((st) => st.kind === "write" && st.outcome === "done");

  return (
    <>
      <div
        ref={listRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          page ? "px-4 py-6 md:px-8" : "px-4 py-3",
          // An empty page puts the greeting and the question box together a little above the middle.
          empty && "flex flex-col justify-end pb-6",
        )}
        aria-live="polite"
      >
        <div className={cn(page && "mx-auto w-full max-w-3xl")}>
          {messages.length === 0 ? (
            page ? (
              <div className="space-y-2 text-center">
                <h2 className="text-2xl font-semibold">{t("greeting")}</h2>
                <p className="mx-auto max-w-md text-sm text-fg-muted">{t("intro")}</p>
              </div>
            ) : (
              <p className="py-6 text-sm text-fg-muted">{t("intro")}</p>
            )
          ) : (
            <ol className={cn(page ? "space-y-6" : "space-y-4")}>
              {messages.map((m, i) => (
                <li key={m.key}>
                  {m.role === "user" ? (
                    <Question
                      message={m}
                      page={page}
                      onEdit={askAgain && i === messages.length - 2 ? (question) => onSend({ question, skill: m.skill }) : undefined}
                    />
                  ) : (
                    <Answer
                      message={m}
                      status={i === messages.length - 1 ? status : null}
                      waiting={i === messages.length - 1 && chat.pending !== null}
                      reasoning={chat.reasoning}
                      last={i === messages.length - 1}
                      onRetry={
                        askAgain && i === messages.length - 1 ? () => onSend({ question: messages[i - 1].content, skill: messages[i - 1].skill }) : undefined
                      }
                      onSource={onSource}
                      onMemory={() => setMemoryOpen(true)}
                      labels={{ stopped: t("stopped"), cutOff: t("cutOff"), thinking: t("thinking") }}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className={cn("shrink-0", page ? "px-4 pb-4 md:px-8" : "border-t border-border p-3")}>
        <div className={cn(page && "mx-auto w-full max-w-3xl")}>
          {blocked && (
            <p role="status" className="mb-2 text-sm text-fg-muted">
              {blocked}
            </p>
          )}
          {error && (
            <p role="alert" className="mb-2 text-sm text-danger">
              {error}
            </p>
          )}
          {!chat.pending && <QueueStrip queued={chat.queued} onClear={chat.clearQueue} />}
          {chat.pending ? (
            <ChangePrompt pending={chat.pending} onDecide={(d) => void chat.decide(d)} onSource={onSource} />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className={cn(
                // A faint edge that firms up a little while typing; the shadow lifts it off the page.
                "relative border border-border/60 bg-bg transition-colors focus-within:border-border",
                page ? "rounded-3xl px-4 pt-3 pb-2.5 shadow-[0_2px_12px_rgb(0_0_0/0.05)]" : "rounded-xl px-2 py-1.5",
              )}
            >
              <SkillList picker={skills} />
              {chat.skill && (
                <SkillChip
                  skill={chat.skill}
                  onRemove={() => {
                    chat.setSkill(null);
                    inputRef.current?.focus();
                  }}
                />
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (skills.onKeyDown(e)) {
                    e.preventDefault();
                    return;
                  }
                  // Backspace in the empty box takes off the picked skill.
                  if (e.key === "Backspace" && !input && chat.skill) {
                    e.preventDefault();
                    chat.setSkill(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={Math.min(6, Math.max(page ? 2 : 1, input.split("\n").length))}
                maxLength={MAX_CHAT_MESSAGE}
                disabled={Boolean(blocked)}
                placeholder={running ? t("placeholderBusy") : t("placeholder")}
                aria-label={t("placeholder")}
                className={cn(
                  "block max-h-40 min-h-7 w-full resize-none bg-transparent py-1 outline-none placeholder:text-fg-faint disabled:opacity-60",
                  page ? "px-1 text-[15px] leading-6" : "text-sm",
                )}
              />
              {/* The highlighted skill, for screen readers: the list itself is under the mouse. */}
              {skills.open && skills.shown.length > 0 && (
                <span className="sr-only" aria-live="polite">
                  {skills.shown[Math.min(skills.active, skills.shown.length - 1)]?.title}
                </span>
              )}
              <div className={cn("flex items-center justify-between gap-2", page && "mt-1")}>
                <div className="flex items-center gap-0.5">
                  <ModePicker mode={chat.mode} onChange={chat.setMode} />
                  <IconButton
                    label={tSkills("pick")}
                    title={tSkills("pickHint")}
                    className="h-7 w-7 disabled:opacity-40 disabled:hover:bg-transparent"
                    disabled={Boolean(blocked) || chat.skill !== null}
                    onClick={() => {
                      if (!input) setInput("/");
                      inputRef.current?.focus();
                    }}
                  >
                    <ScrollText className="h-4 w-4" />
                  </IconButton>
                </div>
                {/* Filled while there is something to send, quiet otherwise. While an answer is on its
                    way, Stop is a ring, and a typed question can be queued beside it. */}
                {running ? (
                  <div className="flex items-center gap-1.5">
                    {input.trim() && (
                      <button
                        type="submit"
                        aria-label={t("queue.add")}
                        title={t("queue.add")}
                        className={cn(round, "text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40")}
                        disabled={Boolean(blocked) || skills.open}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t("stop")}
                      title={t("stop")}
                      className={cn(round, "border-[1.5px] border-fg text-fg hover:bg-bg-hover")}
                      onClick={chat.stop}
                    >
                      <Square className="h-2.5 w-2.5 fill-current" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="submit"
                    aria-label={t("send")}
                    title={t("send")}
                    className={sendButton}
                    disabled={Boolean(blocked) || !input.trim() || skills.open}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </form>
          )}
          {footer}
          <p className={cn("mt-1.5 text-xs text-fg-faint", page && "text-center")}>{t("note")}</p>
        </div>
      </div>
      <MemoryDialog workspaceId={chat.workspaceId} open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      {empty && <div className="flex-[1.4]" aria-hidden />}
    </>
  );
}

type Labels = { stopped: string; cutOff: string; thinking: string };

function Answer({
  message,
  status,
  waiting,
  reasoning,
  last,
  onRetry,
  onSource,
  onMemory,
  labels,
}: {
  message: ChatMessage;
  status: ChatStatus | null;
  /** A change it wants to make waits for the person. */
  waiting: boolean;
  reasoning: Reasoning;
  /** The conversation's latest answer: its actions show without hovering. */
  last: boolean;
  /** Answers its question again, when it may be. */
  onRetry?: () => void;
  onSource: (source: ChatSourceView) => void;
  /** Opens the Memory dialog (from the line saying the answer kept or dropped a note). */
  onMemory: () => void;
  labels: Labels;
}) {
  const t = useTranslations("ai.chat.actions");
  const tMemory = useTranslations("ai.memory");
  // Kept across renders: a new one would redraw the answer's citation buttons as new elements.
  const byNumber = useMemo(() => new Map((message.sources ?? []).map((s) => [s.n, s])), [message.sources]);
  const done = status === null && !waiting && (message.content.trim() !== "" || message.ms !== undefined);
  return (
    <div className="group/answer text-sm leading-relaxed">
      {message.steps ? (
        <Steps message={message} status={status} waiting={waiting} reasoning={reasoning} onSource={onSource} />
      ) : (
        // Answers kept from before steps were.
        status === "thinking" &&
        !message.content && (
          <p className="flex items-center gap-1.5 text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="truncate">{labels.thinking}</span>
          </p>
        )
      )}
      {message.content && <AnswerText text={message.content} sources={byNumber} onSource={onSource} />}
      {message.note && <p className="mt-1 text-xs text-fg-muted">{message.note === "stopped" ? labels.stopped : labels.cutOff}</p>}
      {/* Notes kept or dropped show even with the steps folded: the person should know. */}
      {done && message.steps?.some(changedMemory) && (
        <button type="button" onClick={onMemory} className="-ms-1 mt-1.5 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg">
          <Brain className="h-3.5 w-3.5 shrink-0" />
          {tMemory("updated")}
        </button>
      )}
      {done && (
        <div className={cn("mt-1.5 -ms-1 flex items-center gap-0.5", !last && revealed)}>
          {message.content.trim() && <CopyAction text={stripCitations(message.content).trim()} />}
          {onRetry && (
            <IconButton label={t("retry")} className="h-7 w-7" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {message.at && <MessageTime at={message.at} />}
        </div>
      )}
    </div>
  );
}

/** Actions shown on hovering their message (always on touch screens, and while focused). */
const revealed = "opacity-0 transition-opacity group-hover/answer:opacity-100 group-hover/question:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100";

/** A question: its text, and on hover when it was asked, editing (the last one) and copying. */
function Question({ message, page, onEdit }: { message: ChatMessage; page: boolean; onEdit?: (question: string) => void }) {
  const t = useTranslations("ai.chat");
  const tSkills = useTranslations("skills.chat");
  const tc = useTranslations("common");
  const [draft, setDraft] = useState<string | null>(null);
  const place = page ? "ms-auto w-fit max-w-[80%]" : "ms-8";

  if (draft !== null && onEdit) {
    const submit = () => {
      if (!draft.trim()) return;
      setDraft(null);
      onEdit(draft.trim());
    };
    return (
      <div className={cn("rounded-lg border border-accent bg-bg px-3 py-2", page ? "ms-auto w-full max-w-[80%]" : "ms-8")}>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
            }
            else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          maxLength={MAX_CHAT_MESSAGE}
          aria-label={t("actions.edit")}
          className="block w-full resize-none bg-transparent text-sm outline-none"
        />
        <div className="mt-1.5 flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {t("actions.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={submit}>
            {t("send")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/question">
      {message.skill && (
        <p className={cn("mb-1 flex items-center gap-1.5 text-xs text-fg-muted", page ? "justify-end" : "ms-8")}>
          <ScrollText className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{tSkills("used", { title: message.skill.title || tc("untitled") })}</span>
        </p>
      )}
      <div className={cn("rounded-lg bg-bg-subtle px-3 py-2 text-sm whitespace-pre-wrap break-words", place)}>{message.content}</div>
      <div className={cn("mt-1 flex items-center justify-end gap-0.5", revealed)}>
        {message.at && <MessageTime at={message.at} />}
        {onEdit && (
          <IconButton label={t("actions.edit")} className="h-7 w-7" onClick={() => setDraft(message.content)}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <CopyAction text={message.content} />
      </div>
    </div>
  );
}

/** Copies a message's text, showing a tick for a moment when it did. */
function CopyAction({ text }: { text: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? t("copied") : t("copy")}
      className="h-7 w-7"
      onClick={async (e) => {
        if (!(await copyText(text, e.currentTarget))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/** When a message was written: the time today, the day and time before (the full date on hover). */
function MessageTime({ at }: { at: string }) {
  const locale = useLocale();
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const today = date.toDateString() === new Date().toDateString();
  const shown = date.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <time dateTime={at} title={date.toLocaleString(locale, { dateStyle: "full", timeStyle: "short" })} className="px-1 text-xs text-fg-faint tabular-nums">
      {shown}
    </time>
  );
}

/**
 * The steps an answer took: open with a running clock while it's being written, then folded into
 * how long it took (the person can open it again).
 */
function Steps({
  message,
  status,
  waiting,
  reasoning,
  onSource,
}: {
  message: ChatMessage;
  status: ChatStatus | null;
  waiting: boolean;
  reasoning: Reasoning;
  onSource: (source: ChatSourceView) => void;
}) {
  const t = useTranslations("ai.chat");
  const live = status !== null;
  const [open, setOpen] = useState<boolean | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const ms = live || message.ms === undefined ? Date.now() - (message.startedAt ?? Date.now()) : message.ms;
  const seconds = Math.max(live ? 0 : 1, Math.round(ms / 1000));
  const time = seconds < 60 ? t("steps.seconds", { s: seconds }) : t("steps.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
  const expanded = open ?? live;
  const steps = message.steps ?? [];

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="-ms-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <span className="tabular-nums">{live ? t("steps.working", { time }) : t("steps.worked", { time })}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "rtl:rotate-180")} />
      </button>
      {expanded && (
        <ol className="mt-1 ms-1.5 space-y-1 border-s border-border ps-3 text-fg-muted">
          {steps.map((step, i) => (
            <li key={i} className="flex min-w-0 items-start gap-1.5">
              <StepLine step={step} onSource={onSource} />
            </li>
          ))}
          {waiting ? (
            <li className="flex items-center gap-1.5 text-fg">
              <Hand className="h-3.5 w-3.5 shrink-0" />
              <span>{t("approval.waiting")}</span>
            </li>
          ) : (
            status === "thinking" && <Thinking reasoning={reasoning} />
          )}
        </ol>
      )}
    </div>
  );
}

/** The last line of the model's thinking (its newest words), for the line saying it thinks. */
function thoughtSummary(text: string): string {
  const last = text.replace(/\r\n?/g, "\n").split("\n").reverse().find((l) => l.trim())?.trim() ?? "";
  return last.length > 120 ? `…${last.slice(-119)}` : last;
}

/**
 * The model at work on a turn: "Thinking…" and, when it shows its thinking, the newest line of it;
 * the whole thinking opens from there. It goes once the answer starts or a step is taken.
 */
function Thinking({ reasoning }: { reasoning: Reasoning }) {
  const t = useTranslations("ai.chat");
  const [open, setOpen] = useState(false);
  const text = useReasoning(reasoning).trim();
  const body = useRef<HTMLDivElement>(null);
  // The newest of it stays in view while it streams.
  useEffect(() => {
    if (open && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, text]);
  if (!text) {
    return (
      <li className="flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>{t("thinking")}</span>
      </li>
    );
  }
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ms-1 flex w-full min-w-0 items-center gap-1.5 rounded px-1 text-start hover:bg-bg-hover hover:text-fg"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="shrink-0">{open ? t("thinking") : t("thinking").replace(/(…|\.\.\.)$/, "")}</span>
        {!open && (
          <>
            <span className="shrink-0 text-fg-faint">·</span>
            <span className="min-w-0 truncate text-fg-faint">{thoughtSummary(text)}</span>
          </>
        )}
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
      </button>
      {open && (
        <div ref={body} className="mt-1 max-h-60 overflow-y-auto border-s border-border ps-3 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted">
          {text}
        </div>
      )}
    </li>
  );
}

/** The questions waiting for the answer on its way: how many, the first of them, and clearing them. */
function QueueStrip({ queued, onClear }: { queued: QueuedQuestion[]; onClear: () => void }) {
  const t = useTranslations("ai.chat.queue");
  if (!queued.length) return null;
  const first = queued[0].question;
  return (
    <div role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-1.5 text-xs">
      <Clock className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <span className="shrink-0 text-fg-muted">{t("count", { count: queued.length })}</span>
      <span className="min-w-0 flex-1 truncate" title={first}>
        {first}
      </span>
      <button type="button" onClick={onClear} className="shrink-0 rounded px-1.5 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg">
        {t("clear")}
      </button>
    </div>
  );
}

const MODE_ICONS = { ask: Hand, auto: Zap, read: Eye } as const;

/** What the chat may change, under the question box. */
function ModePicker({ mode, onChange }: { mode: ChatMode; onChange: (mode: ChatMode) => void }) {
  const t = useTranslations("ai.chat.mode");
  const Icon = MODE_ICONS[mode];
  return (
    <Popover
      side="top"
      className="w-64"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${t("label")}: ${t(mode)}`}
          title={t(`${mode}Hint`)}
          className="-ms-1 flex h-7 items-center gap-1 rounded px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Icon className="h-3.5 w-3.5" />
          <span>{t(mode)}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={t("label")}>
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("label")}</p>
          {CHAT_MODES.map((m) => {
            const ItemIcon = MODE_ICONS[m];
            return (
              <MenuItem
                key={m}
                active={m === mode}
                icon={<ItemIcon className="h-4 w-4 shrink-0 self-start mt-0.5" />}
                onClick={() => {
                  onChange(m);
                  close();
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center justify-between gap-2">
                    {t(m)}
                    {m === mode && <Check className="h-3.5 w-3.5 text-fg-muted" />}
                  </span>
                  <span className="text-xs text-fg-muted">{t(`${m}Hint`)}</span>
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

const DECISIONS: ChangeDecision[] = ["approve", "always", "decline"];
/** A note about the person is asked about each time: no "don't ask again" (it would turn on Auto). */
const MEMORY_DECISIONS: ChangeDecision[] = ["approve", "decline"];
const isMemory = (action: PendingChange["action"]) => action.action === "remember" || action.action === "forget";

/**
 * A change the model asks to make, in the box's place: what, where, the values and text it sets,
 * and the choices (1, 2, 3 on the keyboard; Escape says no).
 */
function ChangePrompt({
  pending,
  onDecide,
  onSource,
}: {
  pending: PendingChange;
  onDecide: (decision: ChangeDecision) => void;
  onSource: (source: ChatSourceView) => void;
}) {
  const t = useTranslations("ai.chat.approval");
  const first = useRef<HTMLButtonElement>(null);
  const { action } = pending;
  const memory = isMemory(action);
  const decisions = memory ? MEMORY_DECISIONS : DECISIONS;
  useEffect(() => {
    first.current?.focus();
  }, [pending.id]);

  return (
    <div
      role="group"
      aria-label={t(`question.${action.action}`)}
      className="rounded-lg border border-accent bg-bg p-3 text-sm shadow-sm"
      onKeyDown={(e) => {
        const chosen = e.key === "Escape" ? "decline" : decisions[Number(e.key) - 1];
        if (!chosen || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        onDecide(chosen);
      }}
    >
      <p className="font-medium">{t(`question.${action.action}`)}</p>
      <div className="mt-1.5 space-y-1">
        {action.title && (
          <p className="font-medium break-words text-fg">
            {memory ? (
              `“${action.title}”`
            ) : action.previousTitle !== undefined ? (
              <>
                <span className="text-fg-muted line-through decoration-fg-faint">{action.previousTitle || t("empty")}</span> → {action.title}
              </>
            ) : (
              action.title
            )}
          </p>
        )}
        <p className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
          {memory ? (
            t("memoryHint")
          ) : action.target ? (
            <>
              {t(action.action === "updateRow" ? "row" : action.action === "editPage" ? "page" : "in")}
              <PageLink page={action.target} onSource={onSource} />
            </>
          ) : (
            t("topLevel")
          )}
        </p>
        {action.changes.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {action.changes.map((c, i) => (
              <li key={i} className="break-words">
                <span className="text-fg-muted">{c.property}:</span>{" "}
                {c.before !== undefined && (
                  <>
                    <span className="text-fg-muted line-through decoration-fg-faint">{c.before || t("empty")}</span> →{" "}
                  </>
                )}
                {c.value || <span className="text-fg-muted">{t("cleared")}</span>}
              </li>
            ))}
          </ul>
        )}
        {action.content && <p className="line-clamp-4 rounded bg-bg-subtle px-2 py-1 text-xs whitespace-pre-wrap text-fg-muted">{action.content}</p>}
        {action.diff && action.diff.length > 0 && (
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded bg-bg-subtle px-1 py-1 text-xs">
            <BlockChanges changes={action.diff} compact />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex flex-col gap-px">
        {decisions.map((d, i) => (
          <button
            key={d}
            ref={i === 0 ? first : undefined}
            type="button"
            onClick={() => onDecide(d)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <span className="w-3 shrink-0 text-xs text-fg-faint tabular-nums">{i + 1}</span>
            <span className={cn(d === "decline" && "text-fg-muted")}>{t(d)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// The markdown renderer comes with the first answer, not with every page.
const AnswerMarkdown = lazy(() => import("./answer-markdown"));

function AnswerText({
  text,
  sources,
  onSource,
}: {
  text: string;
  sources: Map<number, ChatSourceView>;
  onSource: (source: ChatSourceView) => void;
}) {
  return (
    <Suspense fallback={<p className="break-words whitespace-pre-wrap">{text}</p>}>
      <AnswerMarkdown text={text} sources={sources} onSource={onSource} />
    </Suspense>
  );
}
