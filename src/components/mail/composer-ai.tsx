"use client";

import type { Editor } from "@tiptap/core";
import { ArrowLeft, Bookmark, Briefcase, CheckCheck, Languages, Minimize2, PenLine, Reply, RotateCcw, SendHorizontal, Smile, Sparkles, Square, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { streamAi } from "@/components/ai-stream";
import { SavedPromptList, SavePromptForm, useSavedPrompts } from "@/components/page/ai-saved-prompts";
import { cn, IconButton, Popover } from "@/components/ui";
import { AI_LANGUAGES, isAiErrorCode } from "@/lib/ai";
import { draftHtml, MAX_MAIL_INSTRUCTION, type MailWriteAction } from "@/lib/mail-ai";
import { plainText, writingRange } from "./writing-range";

/**
 * The composer's AI writer (server/mail-client/ai.ts): writes a reply, reworks what is written or
 * follows the person's instruction, and shows the answer before it goes in. What it works on and
 * replaces is the message's own part: above the signature and the quoted mail (`writingRange`), so
 * those stay as they are. Using the answer is one change in the editor, which Undo takes back.
 */

type Request = { action: MailWriteAction; instruction?: string; language?: string };
type Phase =
  | { step: "menu" }
  | { step: "running"; request: Request }
  | { step: "done"; request: Request; note: "cutOff" | "stopped" | null }
  | { step: "error"; request: Request; message: string };

export function ComposerAi({
  editor,
  workspaceId,
  mailboxId,
  answering,
  subject,
  to,
  headers,
  start,
  onClose,
}: {
  editor: Editor;
  workspaceId: string;
  mailboxId: string;
  /** The message answered or forwarded; a reply can be written only to one. */
  answering: { id: string; reply: boolean } | null;
  subject: string;
  to: string[];
  /** The first lines of what the composer quotes under the message (a reply's or forward's header). */
  headers: string[];
  /** Runs at once when the panel opens ("Reply with AI"). */
  start: MailWriteAction | null;
  onClose: () => void;
}) {
  const t = useTranslations("mail.ai");
  const ta = useTranslations("ai");
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ step: "menu" });
  const [result, setResult] = useState("");
  const [instruction, setInstruction] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const savedPrompts = useSavedPrompts(workspaceId, true);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const context = useRef({ subject, to });
  context.current = { subject, to };

  const run = useCallback(
    async (request: Request) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setResult("");
      setPhase({ step: "running", request });
      const { to: end } = writingRange(editor.state.doc, headers);
      const body = {
        kind: "write",
        mailboxId,
        action: request.action,
        instruction: request.instruction,
        language: request.language,
        draft: plainText(editor.state.doc, end),
        subject: context.current.subject,
        to: context.current.to,
        answering: answering?.id ?? null,
      };
      const failed = (code: string | undefined) =>
        setPhase({ step: "error", request, message: code === "mail" ? t("mailFailed") : ta(`errors.${isAiErrorCode(code) ? code : "provider"}`) });
      let text = "";
      try {
        const ended = await streamAi("/api/ai/mail", body, {
          signal: controller.signal,
          onText: (piece) => {
            text += piece;
            setResult(text);
          },
        });
        if (!ended.ok) return failed(ended.code);
        if (!text.trim()) return failed("empty");
        setPhase({ step: "done", request, note: ended.stopReason === "length" ? "cutOff" : null });
      } catch {
        if (!controller.signal.aborted) return failed("provider");
        // Stopped: what was written so far can still be used.
        if (abort.current === controller) setPhase(text.trim() ? { step: "done", request, note: "stopped" } : { step: "menu" });
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [editor, headers, mailboxId, answering, t, ta],
  );

  const started = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (start && !started.current) {
      started.current = true;
      void run({ action: start });
    } else if (!start) input.current?.focus();
  }, [start, run]);
  // Nothing has the focus while an answer comes, and it grows the panel: keep its buttons in view.
  useEffect(() => {
    if (phase.step !== "menu") panel.current?.scrollIntoView({ block: "nearest" });
  }, [phase.step]);
  useEffect(() => () => abort.current?.abort(), []);

  /** Puts the answer in place of what is written, as one change. */
  const use = () => {
    const range = writingRange(editor.state.doc, headers);
    editor.chain().focus().insertContentAt(range, draftHtml(result)).run();
    onClose();
  };

  const languages = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {}
    return AI_LANGUAGES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);

  const label = (request: Request) =>
    request.action === "custom"
      ? request.instruction
      : request.action === "translate"
        ? `${ta("assistant.translateInto")} ${languages.find((l) => l.code === request.language)?.name ?? ""}`
        : actionLabel(request.action);
  const actionLabel = (action: MailWriteAction) =>
    action === "reply" || action === "formal" || action === "friendly" ? t(action) : ta(`assistant.actions.${action as "improve" | "shorten" | "fix"}`);

  const written = !!plainText(editor.state.doc, writingRange(editor.state.doc, headers).to);
  const action = (key: MailWriteAction, icon: ReactNode) => (
    <ActionButton key={key} onClick={() => void run({ action: key })} icon={icon}>
      {actionLabel(key)}
    </ActionButton>
  );

  return (
    <div
      ref={panel}
      role="region"
      aria-label={t("write")}
      className="border-t border-border bg-bg-subtle"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Escape stops the AI, then closes the panel; the composer doesn't hear it.
        e.preventDefault();
        e.stopPropagation();
        if (abort.current) abort.current.abort();
        else onClose();
      }}
    >
      {phase.step === "menu" ? (
        <>
          <form
            className="flex items-center gap-1 px-3 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = instruction.trim();
              if (!text) return;
              if (answering?.reply && !written) void run({ action: "reply", instruction: text });
              else void run({ action: "custom", instruction: text });
            }}
          >
            <Sparkles className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />
            <input
              ref={input}
              value={instruction}
              maxLength={MAX_MAIL_INSTRUCTION}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={t(answering?.reply && !written ? "placeholderReply" : written ? "placeholderDraft" : "placeholder")}
              aria-label={t("instruction")}
              className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-fg-faint"
            />
            <IconButton label={ta("assistant.saved.saveInstruction")} className="h-8 w-8 text-fg-icon" onClick={() => setSavingPrompt(true)} disabled={!instruction.trim()}>
              <Bookmark className="h-4 w-4" />
            </IconButton>
            <IconButton label={ta("assistant.send")} type="submit" className="h-8 w-8 text-fg-icon" disabled={!instruction.trim()}>
              <SendHorizontal className="h-4 w-4 rtl:-scale-x-100" />
            </IconButton>
            <IconButton label={t("closeWriter")} className="h-8 w-8 text-fg-icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </form>
          {savingPrompt && instruction.trim() && (
            <div className="px-2">
              <SavePromptForm prompts={savedPrompts} prompt={instruction} onDone={() => setSavingPrompt(false)} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1 px-3 pt-1 pb-2">
            {answering?.reply && action("reply", <Reply className="h-3.5 w-3.5" />)}
            {written && (
              <>
                {action("improve", <PenLine className="h-3.5 w-3.5" />)}
                {action("shorten", <Minimize2 className="h-3.5 w-3.5" />)}
                {action("fix", <CheckCheck className="h-3.5 w-3.5" />)}
                {action("formal", <Briefcase className="h-3.5 w-3.5" />)}
                {action("friendly", <Smile className="h-3.5 w-3.5" />)}
                <Popover
                  side="top"
                  className="w-80 p-1"
                  trigger={({ toggle }) => (
                    <ActionButton onClick={toggle} icon={<Languages className="h-3.5 w-3.5" />}>
                      {ta("assistant.actions.translate")}
                    </ActionButton>
                  )}
                >
                  {(close) => (
                    <div role="menu" aria-label={ta("assistant.translateInto")} className="grid max-h-64 grid-cols-2 overflow-y-auto">
                      {languages.map((language) => (
                        <button
                          key={language.code}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            close();
                            void run({ action: "translate", language: language.code });
                          }}
                          className="truncate rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
                        >
                          {language.name}
                        </button>
                      ))}
                    </div>
                  )}
                </Popover>
              </>
            )}
            {!!savedPrompts.list?.length && (
              <Popover
                side="top"
                className="w-72 p-0"
                trigger={({ toggle }) => (
                  <ActionButton onClick={toggle} icon={<Bookmark className="h-3.5 w-3.5" />}>
                    {ta("assistant.saved.title")}
                  </ActionButton>
                )}
              >
                {(close) => (
                  <SavedPromptList
                    prompts={savedPrompts}
                    workspaceId={workspaceId}
                    onUse={(prompt) => {
                      close();
                      void run({ action: written || !answering?.reply ? "custom" : "reply", instruction: prompt });
                    }}
                  />
                )}
              </Popover>
            )}
          </div>
        </>
      ) : (
        <div>
          <div className="flex items-center gap-2 px-3 pt-2 text-xs text-fg-muted">
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{label(phase.request)}</span>
            {phase.step === "running" && <span aria-live="polite">{ta("assistant.writing")}</span>}
          </div>
          {phase.step === "error" ? (
            <p role="alert" className="px-3 py-2 text-sm text-danger">
              {phase.message}
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" aria-live="polite" aria-busy={phase.step === "running"}>
              {result || <span className="text-fg-faint">{ta("assistant.writing")}</span>}
            </div>
          )}
          {phase.step === "done" && (
            <p className="px-3 text-xs text-fg-faint">{phase.note === "cutOff" ? ta("assistant.cutOff") : phase.note === "stopped" ? ta("assistant.stopped") : t("useNote")}</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-1 px-3 pt-1 pb-2">
            {phase.step === "running" ? (
              <ActionButton onClick={() => abort.current?.abort()} icon={<Square className="h-3 w-3" />}>
                {ta("assistant.stop")}
              </ActionButton>
            ) : (
              <>
                <ActionButton
                  onClick={() => {
                    setResult("");
                    setPhase({ step: "menu" });
                  }}
                  icon={<ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />}
                >
                  {ta("assistant.back")}
                </ActionButton>
                <ActionButton onClick={() => void run(phase.request)} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                  {ta("assistant.retry")}
                </ActionButton>
                {phase.step === "done" && (
                  <ActionButton primary onClick={use}>
                    {t("use")}
                  </ActionButton>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButton({ children, icon, onClick, primary }: { children: ReactNode; icon?: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
        primary ? "bg-accent text-accent-fg hover:opacity-90" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
