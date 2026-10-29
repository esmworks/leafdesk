"use client";

/**
 * A conversation's messages and the question box, as the panel and the full-page chat show them.
 * Answers render as markdown with their citations (numbered links to the pages, no list of sources
 * below), under the steps taken to them
 * (searches, pages read, changes made): listed as they happen, then folded into how long it took.
 * Before the first question, a strip tucked behind the box's top edge picks a plain question or
 * research and where answers come from. In its toolbar, a menu adding files or a skill and what the chat may change (ask, auto, read
 * only) on the left, the model (where there is a choice), dictation and Send on the right; a change
 * it asks about takes the box's place until the person decides.
 * A research report can be saved as a page. Questions asked while an answer is on its way wait in a
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
  Cpu,
  ExternalLink,
  Eye,
  FilePlus,
  Hand,
  Globe,
  Crosshair,
  Lightbulb,
  Loader2,
  MessageCircle,
  MessageSquareDiff,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  ScrollText,
  Square,
  Telescope,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePropertyTypeLabel } from "@/components/database/property-icons";
import { BlockChanges } from "@/components/page/history-diff";
import { copyText } from "@/components/settings/copy-button";
import { Button, cn, IconButton, MenuItem, Popover } from "@/components/ui";
import {
  CHAT_MODES,
  CHAT_THINKING,
  changedMemory,
  changedThings,
  type ChatMode,
  type ChatOptions,
  type ChatSourceView,
  type ChatThinking,
  stripCitations,
} from "@/lib/ai-chat";
import { CHAT_FILE_ACCEPT, chatFileKind } from "@/lib/chat-attachments";
import { PROPERTY_TYPES, type PropertyType } from "@/lib/property-types";
import { caretOutsideLabels, deleteLabel, insertDictation, normalizePaste, shouldCollapsePaste, type PastePart } from "@/lib/chat-paste";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import { AnswerText } from "./answer-text";
import { AttachmentChip } from "./attachment-chip";
import { useCanRecord } from "@/components/voice/dictation";
import { chipTrigger } from "./composer-chip";
import { DictateButton, type DictationNotice } from "./dictate-button";
import { MemoryDialog } from "./memory-dialog";
import { SkillChip, SkillList, useSkillPicker } from "./skill-picker";
import { PageLink, StepLine } from "./step-line";
import { useReasoning, type ChangeDecision, type Chat, type ChatMessage, type ChatSkillPick, type ChatStatus, type PendingChange, type QueuedQuestion, type Reasoning } from "./use-chat";

export function ChatThread({
  chat,
  blocked,
  onSend,
  onSource,
  scope,
  starters,
  variant,
  voice,
}: {
  chat: Chat;
  /** Why questions can't be asked now (offline, AI off), shown above the box. */
  blocked: string | null;
  /** Asks the typed question; with `again`, its question (and skill) in place of the last question and answer. */
  onSend: (again?: { question: string; skill?: ChatSkillPick }) => void;
  onSource: (source: ChatSourceView) => void;
  /** Where answers come from (ScopePicker), in the strip above the box before the first question. */
  scope?: ReactNode;
  /** Under the empty page's box: questions to start from (ChatStarters). */
  starters?: ReactNode;
  variant: "panel" | "page";
  /** The recording limits when questions can be dictated here, else null. */
  voice: VoiceNoteLimits | null;
}) {
  const t = useTranslations("ai.chat");
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Files go in through the button, by dropping them on the box, or pasted.
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const { messages, status, error, input, setInput, running, inputRef } = chat;
  const listRef = useRef<HTMLDivElement>(null);
  const page = variant === "page";
  // An empty page's box stands on its own under the greeting: roomier, and lifted off the page.
  const fresh = messages.length === 0;
  const empty = page && fresh;
  // While the box holds a paste, its text is drawn behind it with the labels as chips.
  const chipsRef = useRef<HTMLDivElement>(null);
  const caretWas = useRef(0);
  const chips = chat.pastes.length > 0;
  const boxText = cn("block w-full text-sm leading-normal", empty ? "min-h-[46px]" : "min-h-10");
  // The box grows with what is typed, up to its max-height, then scrolls.
  useLayoutEffect(() => {
    const box = inputRef.current;
    if (box) {
      box.style.height = "auto";
      box.style.height = `${box.scrollHeight}px`;
    }
    if (chipsRef.current && box) chipsRef.current.scrollTop = box.scrollTop;
  }, [input, inputRef, empty]);
  // The list's scrollbar takes room from its side of the messages' column; the box below takes the
  // same room, so its edges stay in line with the messages above it.
  const [gutter, setGutter] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const left = el.clientLeft;
      const right = el.offsetWidth - el.clientWidth - left;
      setGutter((was) => (was.left === left && was.right === right ? was : { left, right }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Dictating a question, where the workspace can transcribe and the browser can record.
  const canRecord = useCanRecord();
  const [dictation, setDictation] = useState<DictationNotice>(null);
  const dictated = useCallback(
    (text: string) => {
      const box = inputRef.current;
      if (!box) return;
      // The box as it is now (typing may have gone on meanwhile), at the caret it keeps while the
      // button has focus.
      const next = insertDictation(box.value, text, box.selectionStart, box.selectionEnd);
      setInput(next.text);
      box.focus();
      requestAnimationFrame(() => box.setSelectionRange(next.caret, next.caret));
    },
    [inputRef, setInput],
  );
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
  // The answers' renderer, while the conversation's messages load.
  useEffect(() => {
    void AnswerText.preload();
  }, []);
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

  const hasFiles = chat.files.length > 0;
  // A question waits for its files to be uploaded.
  const uploading = chat.files.some((f) => f.uploading);
  const send = () => {
    if (blocked) return;
    setDictation(null);
    onSend();
  };
  const round = cn(roundButton, empty ? "h-7 w-7" : "h-[26px] w-[26px]");
  // Send and Stop are filled; Send is faded while there is nothing to send.
  const filled = cn(round, "bg-fg text-bg enabled:hover:opacity-85 disabled:opacity-35");
  // The last question can be answered again, or edited, unless its answer changed things (that
  // would make them twice).
  const last = messages[messages.length - 1];
  const askAgain =
    !running &&
    !blocked &&
    chat.conversationId !== null &&
    messages.length >= 2 &&
    last.role === "assistant" &&
    !last.steps?.some(changedThings);

  return (
    <>
      <div
        ref={listRef}
        className={cn(
          // A scrollbar's room is kept from the start, so the column doesn't shift when the answers fill the page.
          "min-h-0 flex-1 overflow-y-auto font-sans [scrollbar-gutter:stable]",
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
                      onSaveReport={m.research && chat.conversationId ? () => chat.saveReport(i) : undefined}
                      workspaceId={chat.workspaceId}
                      labels={{ stopped: t("stopped"), cutOff: t("cutOff"), thinking: t("thinking") }}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div
        // The list's padding plus its scrollbar's room on each side (measured above).
        className={cn(
          "shrink-0 pr-[calc(1rem+var(--gutter-r))] pl-[calc(1rem+var(--gutter-l))]",
          page ? "pb-4 md:pr-[calc(2rem+var(--gutter-r))] md:pl-[calc(2rem+var(--gutter-l))]" : "pt-1 pb-3",
        )}
        style={{ "--gutter-l": `${gutter.left}px`, "--gutter-r": `${gutter.right}px` } as React.CSSProperties}
      >
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
          {dictation && (
            <p role={dictation.error ? "alert" : "status"} className={cn("mb-2 text-sm", dictation.error ? "text-danger" : "text-fg-muted")}>
              {dictation.message}
            </p>
          )}
          {!chat.pending && <QueueStrip queued={chat.queued} onClear={chat.clearQueue} />}
          {chat.pending ? (
            <ChangePrompt pending={chat.pending} onDecide={(d) => void chat.decide(d)} onSource={onSource} />
          ) : (
            <div className={cn("rounded-2xl", empty && "shadow-[0_1px_3px_rgb(16_24_40/0.05),0_10px_30px_rgb(16_24_40/0.08)] dark:shadow-[0_1px_3px_rgb(0_0_0/0.28),0_10px_30px_rgb(0_0_0/0.32)]")}>
              {/* Before the first question, a strip above the box, its lower edge tucked behind it: what kind of
                  question, and where answers come from; both stay as picked for the conversation. Below the page in
                  the dark, the box above it; narrow, its choices drop their icons. */}
              {fresh && (
                <div className="@container -mb-3.5 flex items-center gap-2 rounded-t-2xl bg-bg-subtle px-2.5 pt-2 pb-6 dark:bg-black/25">
                  <KindTabs research={chat.research} onChange={chat.setResearch} />
                  <span className="flex-1" />
                  {scope}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
                onDragOver={(e) => {
                  if (blocked || !carriesFiles(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setDropping(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
                }}
                onDrop={(e) => {
                  if (!carriesFiles(e)) return;
                  e.preventDefault();
                  setDropping(false);
                  if (!blocked) void chat.attachFiles(Array.from(e.dataTransfer.files));
                }}
                className={cn(
                  "relative flex flex-col rounded-2xl border bg-bg transition-colors dark:bg-bg-subtle",
                  empty ? "gap-4 px-4 pt-3.5 pb-3" : "gap-2.5 px-3.5 pt-3 pb-2.5",
                  dropping ? "border-accent ring-1 ring-accent" : "border-border",
                )}
              >
                {dropping && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-bg/90 text-sm text-fg-muted">
                    {t("files.drop")}
                  </div>
                )}
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
                {hasFiles && (
                  <div className="flex flex-wrap gap-1.5">
                    {chat.files.map((f) => (
                      <AttachmentChip key={f.id} file={f} onRemove={() => chat.removeFile(f.id)} />
                    ))}
                  </div>
                )}
                <div className="relative">
                  {chips && <PasteChips text={input} pastes={chat.pastes} boxRef={chipsRef} className={boxText} />}
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onScroll={(e) => {
                      if (chipsRef.current) chipsRef.current.scrollTop = e.currentTarget.scrollTop;
                    }}
                    // A label is one piece: the caret steps over it.
                    onSelect={(e) => {
                      const box = e.currentTarget;
                      if (box.selectionStart !== box.selectionEnd) return;
                      const at = caretOutsideLabels(chat.pastes, box.selectionStart, caretWas.current);
                      if (at !== box.selectionStart) box.setSelectionRange(at, at);
                      caretWas.current = at;
                    }}
                    // A long paste goes in as a label (the text itself is sent in its place).
                    onPaste={(e) => {
                      // A copied file or image is attached, not pasted as its name.
                      const pasted = Array.from(e.clipboardData.files).filter((f) => chatFileKind(f.type, f.name) !== null);
                      if (pasted.length) {
                        e.preventDefault();
                        void chat.attachFiles(pasted);
                        return;
                      }
                      const raw = e.clipboardData.getData("text/plain");
                      if (!raw || !shouldCollapsePaste(raw)) return;
                      e.preventDefault();
                      const box = e.currentTarget;
                      const caret = chat.pasteInput(normalizePaste(raw), box.selectionStart, box.selectionEnd);
                      requestAnimationFrame(() => box.setSelectionRange(caret, caret));
                    }}
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
                      // …and Backspace or Delete next to a label takes all of it.
                      const box = e.currentTarget;
                      if ((e.key === "Backspace" || e.key === "Delete") && box.selectionStart === box.selectionEnd) {
                        const cut = deleteLabel({ text: input, pastes: chat.pastes }, box.selectionStart, e.key);
                        if (cut) {
                          e.preventDefault();
                          setInput(cut.text);
                          caretWas.current = cut.caret;
                          requestAnimationFrame(() => box.setSelectionRange(cut.caret, cut.caret));
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={1}
                    disabled={Boolean(blocked)}
                    placeholder={running ? t("placeholderBusy") : chat.research ? t("research.placeholder") : t("placeholder")}
                    aria-label={t("placeholder")}
                    className={cn(
                      boxText,
                      "relative resize-none bg-transparent outline-none placeholder:text-fg-faint disabled:opacity-60",
                      empty ? "max-h-[220px]" : "max-h-[180px]",
                      chips && "text-transparent caret-fg selection:bg-accent/25 selection:text-transparent",
                    )}
                  />
                </div>
                {/* The highlighted skill, for screen readers: the list itself is under the mouse. */}
                {skills.open && skills.shown.length > 0 && (
                  <span className="sr-only" aria-live="polite">
                    {skills.shown[Math.min(skills.active, skills.shown.length - 1)]?.title}
                  </span>
                )}
                {/* What goes in with the question and what the chat may change on the left; the model, dictation and Send on the right. */}
                <div className={cn("flex min-w-0 items-center", empty ? "gap-3" : "gap-2")}>
                  <AddMenu
                    className={cn(round, "border border-border text-fg hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent")}
                    disabled={Boolean(blocked)}
                    skillPicked={chat.skill !== null}
                    onAttach={() => fileInput.current?.click()}
                    onSkill={() => {
                      if (!input) setInput("/");
                      inputRef.current?.focus();
                    }}
                  />
                  <input
                    ref={fileInput}
                    type="file"
                    accept={CHAT_FILE_ACCEPT}
                    multiple
                    hidden
                    onChange={(e) => {
                      const picked = Array.from(e.currentTarget.files ?? []);
                      e.currentTarget.value = "";
                      if (picked.length) void chat.attachFiles(picked);
                    }}
                  />
                  <ModePicker
                    mode={chat.mode}
                    onChange={chat.setMode}
                    research={chat.research}
                    asSuggestions={chat.asSuggestions}
                    onSuggestions={chat.setAsSuggestions}
                  />
                  <span className="flex-1" />
                  {chat.options.models.length > 1 && <ModelPicker models={chat.options.models} model={chat.model ?? chat.options.models[0].id} onChange={chat.setModel} />}
                  {!chat.research && (chat.options.models.find((m) => m.id === chat.model) ?? chat.options.models[0])?.thinks && (
                    <ThinkingPicker thinking={chat.thinking} onChange={chat.setThinking} />
                  )}
                  {voice && canRecord && (
                    <DictateButton workspaceId={chat.workspaceId} limits={voice} disabled={Boolean(blocked)} onText={dictated} onNotice={setDictation} />
                  )}
                  {/* While an answer is on its way, Send becomes Stop, and a typed question can be queued beside it. */}
                  {running ? (
                    <div className="flex items-center gap-1.5">
                      {(input.trim() || hasFiles) && (
                        <button
                          type="submit"
                          aria-label={t("queue.add")}
                          title={t("queue.add")}
                          className={cn(round, "border border-border text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40")}
                          disabled={Boolean(blocked) || uploading || skills.open}
                        >
                          <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </button>
                      )}
                      <button type="button" aria-label={t("stop")} title={t("stop")} className={filled} onClick={chat.stop}>
                        <Square className="h-2.5 w-2.5 fill-current" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="submit"
                      aria-label={t("send")}
                      title={t("send")}
                      className={filled}
                      disabled={Boolean(blocked) || uploading || (!input.trim() && !hasFiles) || skills.open}
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
          {empty && starters}
        </div>
      </div>
      <MemoryDialog workspaceId={chat.workspaceId} open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      {empty && <div className="flex-[1.4]" aria-hidden />}
    </>
  );
}

/**
 * The chat box's text, drawn behind the box (whose own text is clear) with each paste's label as a
 * chip; its brackets stay in place, unseen, as the chip's padding, so the text lines up.
 */
function PasteChips({ text, pastes, boxRef, className }: { text: string; pastes: PastePart[]; boxRef: RefObject<HTMLDivElement | null>; className: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const paste of pastes) {
    parts.push(text.slice(at, paste.start));
    const bracketed = paste.label.startsWith("[") && paste.label.endsWith("]");
    parts.push(
      <span key={paste.start} className="rounded-md bg-bg-active text-fg-muted">
        {bracketed ? (
          <>
            <span className="text-transparent">[</span>
            {paste.label.slice(1, -1)}
            <span className="text-transparent">]</span>
          </>
        ) : (
          paste.label
        )}
      </span>,
    );
    at = paste.end;
  }
  // A last empty line takes room in the box too.
  parts.push(`${text.slice(at)} `);
  return (
    <div ref={boxRef} aria-hidden className={cn(className, "pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap")}>
      {parts}
    </div>
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
  onSaveReport,
  workspaceId,
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
  /** A research report: saves it as a page, giving its id (null when it couldn't). */
  onSaveReport?: () => Promise<string | null>;
  workspaceId: string;
  labels: Labels;
}) {
  const t = useTranslations("ai.chat.actions");
  const tResearch = useTranslations("ai.chat.research");
  const [saving, setSaving] = useState(false);
  const [savedPage, setSavedPage] = useState<string | null>(null);
  const tMemory = useTranslations("ai.memory");
  // Kept across renders: a new one would redraw the answer's citation buttons as new elements.
  const byNumber = useMemo(() => new Map((message.sources ?? []).map((s) => [s.n, s])), [message.sources]);
  const done = status === null && !waiting && (message.content.trim() !== "" || message.ms !== undefined);
  return (
    <div className="group/answer font-sans text-sm leading-normal">
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
          {onSaveReport && message.content.trim() && !message.note && (
            savedPage ? (
              <a href={`/w/${workspaceId}/p/${savedPage}`} className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg">
                <ExternalLink className="h-3.5 w-3.5" />
                {tResearch("openPage")}
              </a>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setSavedPage(await onSaveReport());
                  setSaving(false);
                }}
                className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus className="h-3.5 w-3.5" />}
                {tResearch("save")}
              </button>
            )
          )}
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
      {message.research && (
        <p className={cn("mb-1 flex items-center gap-1.5 text-xs text-fg-muted", page ? "justify-end" : "ms-8")}>
          <Telescope className="h-3.5 w-3.5 shrink-0" />
          <span>{t("research.asked")}</span>
        </p>
      )}
      {message.scope && (
        <p className={cn("mb-1 flex items-center gap-1.5 text-xs text-fg-muted", page ? "justify-end" : "ms-8")}>
          <Crosshair className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {message.scope.title === null
              ? t(`scopeAsked.${message.scope.kind}Unknown`)
              : t(`scopeAsked.${message.scope.kind}`, { title: message.scope.title || tc("untitled") })}
          </span>
        </p>
      )}
      {message.skill && (
        <p className={cn("mb-1 flex items-center gap-1.5 text-xs text-fg-muted", page ? "justify-end" : "ms-8")}>
          <ScrollText className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{tSkills("used", { title: message.skill.title || tc("untitled") })}</span>
        </p>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className={cn("mb-1 flex flex-wrap gap-1.5", page ? "justify-end" : "ms-8")}>
          {message.attachments.map((f) => (
            <AttachmentChip key={f.id} file={f} />
          ))}
        </div>
      )}
      {message.content && <div className={cn("rounded-lg bg-bg-subtle px-3 py-2 text-sm whitespace-pre-wrap break-words", place)}>{message.content}</div>}
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

/** The box's round buttons (add, Send, Stop); the box gives their size. */
const roundButton = "inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,opacity]";

/** Above the box: a question answered from the workspace, or research that ends in a report. */
function KindTabs({ research, onChange }: { research: boolean; onChange: (research: boolean) => void }) {
  const t = useTranslations("ai.chat.kind");
  const tResearch = useTranslations("ai.chat.research");
  const tabs = [
    { on: !research, value: false, Icon: MessageCircle, label: t("chat"), hint: t("chatHint") },
    { on: research, value: true, Icon: Telescope, label: tResearch("toggle"), hint: tResearch("toggleHint") },
  ];
  return (
    <div role="group" aria-label={t("label")} className="flex items-center gap-0.5">
      {tabs.map(({ on, value, Icon, label, hint }) => (
        <button
          key={label}
          type="button"
          aria-pressed={on}
          title={hint}
          onClick={() => onChange(value)}
          className={cn(
            "flex h-[26px] items-center gap-1.5 rounded-[7px] px-[7px] text-[13px] transition-colors",
            on ? "bg-bg text-fg shadow-[0_0_0_1px_var(--color-border)]" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
          )}
        >
          <Icon className="hidden h-3.5 w-3.5 @sm:block" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** What can go in with a question: files, and a skill. */
function AddMenu({
  className,
  disabled,
  skillPicked,
  onAttach,
  onSkill,
}: {
  className: string;
  disabled: boolean;
  skillPicked: boolean;
  onAttach: () => void;
  onSkill: () => void;
}) {
  const t = useTranslations("ai.chat");
  const tSkills = useTranslations("skills.chat");
  return (
    <Popover
      side="top"
      className="w-72"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("add")}
          title={t("add")}
          className={className}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={t("add")}>
          <MenuItem
            icon={<Paperclip className="h-4 w-4 shrink-0 self-start mt-0.5" />}
            onClick={() => {
              close();
              onAttach();
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              {t("files.attach")}
              <span className="text-xs whitespace-normal text-fg-muted">{t("files.attachHint")}</span>
            </span>
          </MenuItem>
          <MenuItem
            icon={<ScrollText className="h-4 w-4 shrink-0 self-start mt-0.5" />}
            disabled={skillPicked}
            onClick={() => {
              close();
              onSkill();
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              {tSkills("pick")}
              <span className="text-xs whitespace-normal text-fg-muted">{tSkills("pickHint")}</span>
            </span>
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

/** What the chat may change, under the question box. */
function ModePicker({
  mode,
  onChange,
  research,
  asSuggestions,
  onSuggestions,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
  research: boolean;
  /** What it writes in page bodies goes in as suggested edits (lib/ai-suggestions). */
  asSuggestions: boolean;
  onSuggestions: (on: boolean) => void;
}) {
  const t = useTranslations("ai.chat.mode");
  const tResearch = useTranslations("ai.chat.research");
  const Icon = MODE_ICONS[mode];
  // Research only reads, whatever the mode.
  if (research) {
    return (
      <span title={tResearch("readOnly")} className="flex h-[26px] shrink-0 items-center gap-1.5 px-[7px] text-[13px] text-fg-muted">
        <Eye className="h-3.5 w-3.5" />
        <span>{t("read")}</span>
      </span>
    );
  }
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
          className={chipTrigger}
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
          <MenuItem
            pressed={asSuggestions}
            icon={<MessageSquareDiff className="h-4 w-4 shrink-0 self-start mt-0.5" />}
            onClick={() => {
              onSuggestions(!asSuggestions);
              close();
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center justify-between gap-2">
                {t("asSuggestions")}
                {asSuggestions && <Check className="h-3.5 w-3.5 text-fg-muted" />}
              </span>
              <span className="text-xs text-fg-muted">{t("asSuggestionsHint")}</span>
            </span>
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

/** The model questions go to, where the workspace's AI offers more than one. */
function ModelPicker({ models, model, onChange }: { models: ChatOptions["models"]; model: string; onChange: (model: string) => void }) {
  const t = useTranslations("ai.chat.model");
  const name = models.find((m) => m.id === model)?.name ?? model;
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
          aria-label={`${t("label")}: ${name}`}
          title={t("hint")}
          className={cn(chipTrigger, "max-w-44")}
        >
          <Cpu className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={t("label")}>
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("label")}</p>
          {models.map((m) => (
            <MenuItem
              key={m.id}
              active={m.id === model}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{m.name}</span>
                  {m.id === model && <Check className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
                </span>
                {/* The id is what AI_CHAT_MODELS and the provider's console call it. */}
                {m.name !== m.id && <span className="truncate text-xs text-fg-faint">{m.id}</span>}
                {m.images && <span className="text-xs text-fg-muted">{t("images")}</span>}
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** How much the model thinks, where it thinks (research thinks as it does, so it isn't shown then). */
function ThinkingPicker({ thinking, onChange }: { thinking: ChatThinking; onChange: (thinking: ChatThinking) => void }) {
  const t = useTranslations("ai.chat.thinkingLevel");
  return (
    // At the box's right edge, beside Send: the menu opens toward the left.
    <Popover
      side="top"
      align="end"
      className="w-64"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${t("label")}: ${t(thinking)}`}
          title={t("hint")}
          className={chipTrigger}
        >
          <Lightbulb className="h-3.5 w-3.5 shrink-0" />
          <span>{t(thinking)}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={t("label")}>
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("label")}</p>
          {CHAT_THINKING.map((level) => (
            <MenuItem
              key={level}
              active={level === thinking}
              onClick={() => {
                onChange(level);
                close();
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center justify-between gap-2">
                  <span>{t(level)}</span>
                  {level === thinking && <Check className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
                </span>
                {/* MenuItem keeps its line on one row; the hint wraps. */}
                <span className="text-xs whitespace-normal text-fg-muted">{t(`${level}Hint`)}</span>
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

const DECISIONS: ChangeDecision[] = ["approve", "always", "decline"];
/**
 * A note about the person, a call to a connection's tool that changes something and a web call
 * are asked about each time: no "don't ask again" (it would turn on Auto, which doesn't cover them).
 */
const EACH_TIME_DECISIONS: ChangeDecision[] = ["approve", "decline"];
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
  const typeLabel = usePropertyTypeLabel();
  const first = useRef<HTMLButtonElement>(null);
  const { action } = pending;
  const comment = action.action === "addComment";
  const memory = isMemory(action);
  // A call to a connection's tool or to one of Leafdesk's further tools: shown as what it is given.
  const call = action.action === "connection" || action.action === "tool";
  // A web call: the address or the words, exactly as they would leave the workspace.
  const web = action.action === "readWeb" || action.action === "searchWeb";
  const decisions = memory || action.action === "connection" || action.eachTime || web ? EACH_TIME_DECISIONS : DECISIONS;
  const question = action.action === "connection" ? t("question.connection", { connection: action.connection?.name ?? "" }) : t(`question.${action.action}`);
  useEffect(() => {
    first.current?.focus();
  }, [pending.id]);

  return (
    <div
      role="group"
      aria-label={question}
      className="rounded-lg border border-accent bg-bg p-3 text-sm shadow-sm"
      onKeyDown={(e) => {
        const chosen = e.key === "Escape" ? "decline" : decisions[Number(e.key) - 1];
        if (!chosen || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        onDecide(chosen);
      }}
    >
      <p className="font-medium">{question}</p>
      <div className="mt-1.5 space-y-1">
        {action.title && comment && (
          <p className="border-s-2 border-border ps-2 text-xs break-words text-fg-muted">“{action.title}”</p>
        )}
        {action.title && web && <p className="rounded bg-bg-subtle px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-fg">{action.title}</p>}
        {action.title && !comment && !web && (
          <p className="font-medium break-words text-fg">
            {memory ? (
              `“${action.title}”`
            ) : call ? (
              action.title
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
          ) : call ? (
            action.action === "tool" ? t("toolHint") : t("connectionHint", { connection: action.connection?.name ?? "" })
          ) : web ? (
            t(action.action === "readWeb" ? "readWebHint" : "searchWebHint")
          ) : action.target ? (
            <>
              {t(action.action === "updateRow" ? "row" : action.action === "editPage" || action.action === "createPdf" || comment ? "page" : "in")}
              <PageLink page={action.target} onSource={onSource} />
            </>
          ) : (
            t("topLevel")
          )}
        </p>
        {action.letterhead && <p className="text-xs break-words text-fg-muted">{t("letterhead", { name: action.letterhead })}</p>}
        {action.fromFile && <p className="text-xs text-fg-muted">{t("fromFile", { rows: action.fromFile.rows, name: action.fromFile.name })}</p>}
        {action.properties && action.properties.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {action.properties.map((p, i) => (
              <li key={i} className="break-words">
                {p.name && <span className="text-fg-muted">{p.name}: </span>}
                {p.type === "title" ? t("titleColumn") : PROPERTY_TYPES.includes(p.type as PropertyType) ? typeLabel(p.type as PropertyType) : p.type}
                {p.options && p.options.length > 0 && <span className="text-fg-muted"> · {p.options.join(", ")}</span>}
              </li>
            ))}
          </ul>
        )}
        {action.changes.length > 0 && !action.properties && (
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
        {action.content &&
          (call ? (
            <pre className="max-h-40 overflow-auto rounded bg-bg-subtle px-2 py-1 text-xs break-all whitespace-pre-wrap text-fg-muted">{action.content}</pre>
          ) : (
            <p className="line-clamp-4 rounded bg-bg-subtle px-2 py-1 text-xs whitespace-pre-wrap text-fg-muted">{action.content}</p>
          ))}
        {action.publicForm && (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            {t(`publicForm.${action.publicForm}`)}
          </p>
        )}
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

