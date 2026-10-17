"use client";

/**
 * The AI writing assistant in the page editor (#40): "Ask AI" in the formatting toolbar and the
 * slash menu opens a panel under the selection (or the cursor). The model's answer streams into
 * the panel as a suggestion; nothing changes on the page until the person picks "Replace
 * selection" or "Insert below". Before either, the server saves a history version ("Before AI
 * assistant edit"). The change itself is made in this editor, which is bound to the page's shared
 * document: everyone else sees it live and Undo takes it back. Closing the panel or "Stop" cancels
 * the request.
 */
import { FormattingToolbarExtension, ShowSelectionExtension } from "@blocknote/core/extensions";
import { useComponentsContext, useExtension, type DefaultReactSuggestionItem } from "@blocknote/react";
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  FileText,
  Languages,
  ListEnd,
  Minimize2,
  PenLine,
  RotateCcw,
  SendHorizontal,
  Square,
  Replace,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { TextSelection } from "prosemirror-state";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import type { RelativePosition } from "yjs";
import { snapshotBeforeAiEditAction } from "@/app/actions/ai";
import { cn } from "@/components/ui";
import { AI_LANGUAGES, isAiErrorCode, type EditorAction } from "@/lib/ai";
import { CALLOUT_BLOCK } from "@/lib/content-blocks";
import type { PageEditor } from "./embed-blocks";
import { isRtl } from "@/components/direction";

type AnyBlock = PageEditor["document"][number];

/** What the panel works on, captured when it opens (the editor's selection is gone once it's used). */
type Target = {
  /** Selected text as Markdown; empty without a selection. */
  text: string;
  /** The selection as plain text, to notice when someone changed it meanwhile. */
  plain: string;
  /** Where the selection was, as positions in the shared document (they follow others' edits). */
  range: { from: RelativePosition; to: RelativePosition } | { from: number; to: number } | null;
  /** The page up to and including the block with the cursor, as Markdown (to write on from). */
  before: string;
  /** New text goes after this block. */
  blockId: string;
  top: number;
  left: number;
};

type Phase =
  | { step: "menu" }
  | { step: "language" }
  | { step: "running"; action: EditorAction; request: Request }
  | { step: "done"; action: EditorAction; request: Request; note: "cutOff" | "stopped" | null }
  | { step: "error"; action: EditorAction; request: Request; message: string }
  /** Applied, with something to say about it. */
  | { step: "notice"; message: string };

type Request = { action: EditorAction; language?: string; instruction?: string };

const PANEL_WIDTH = 480;

export type AiAssist = {
  /** Opens the panel for the current selection; with an action, starts it right away. */
  open: (action?: "continue" | "summarize") => void;
  panel: ReactNode;
};

/** The assistant's state for one editor. `enabled`: the person may edit and AI is available. */
export function useAiAssist(editor: PageEditor, pageId: string, enabled: boolean): AiAssist {
  const t = useTranslations("ai");
  const locale = useLocale();
  const [target, setTarget] = useState<Target | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "menu" });
  const [result, setResult] = useState("");
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showSelection = useCallback(
    (show: boolean) => {
      try {
        editor.getExtension(ShowSelectionExtension)?.showSelection(show, "aiAssist");
      } catch {}
    },
    [editor],
  );

  const close = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setTarget(null);
    setPhase({ step: "menu" });
    setResult("");
    setInstruction("");
    setNotice(null);
    showSelection(false);
  }, [showSelection]);

  const run = useCallback(
    async (request: Request, on: Target) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setResult("");
      setNotice(null);
      setPhase({ step: "running", action: request.action, request });
      const body = {
        pageId,
        action: request.action,
        language: request.language,
        instruction: request.instruction,
        text: on.text || undefined,
        before: request.action === "continue" || (request.action === "custom" && !on.text) ? on.before : undefined,
      };
      const failed = (code: unknown) =>
        setPhase({ step: "error", action: request.action, request, message: t(`errors.${isAiErrorCode(code) ? code : "provider"}`) });
      let text = "";
      try {
        const response = await fetch("/api/ai/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const error = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
          failed(error?.error?.code);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let stopReason: string | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as { type: string; text?: string; code?: string; stopReason?: string };
            if (event.type === "text" && event.text) {
              text += event.text;
              setResult(text);
            } else if (event.type === "error") {
              failed(event.code);
              return;
            } else if (event.type === "done") stopReason = event.stopReason ?? "stop";
          }
        }
        if (!stopReason) {
          failed("provider");
          return;
        }
        if (!text.trim()) {
          failed("empty");
          return;
        }
        setPhase({ step: "done", action: request.action, request, note: stopReason === "length" ? "cutOff" : null });
      } catch {
        if (controller.signal.aborted) {
          // Stopped: what was written so far can still be kept.
          if (abort.current === controller) {
            setPhase(text.trim() ? { step: "done", action: request.action, request, note: "stopped" } : { step: "menu" });
          }
          return;
        }
        failed("provider");
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [pageId, t],
  );

  const open = useCallback(
    (action?: "continue" | "summarize") => {
      if (!enabled) return;
      const captured = captureTarget(editor);
      if (!captured) return;
      setTarget(captured);
      setResult("");
      setInstruction("");
      setNotice(null);
      if (captured.text) showSelection(true);
      if (action) void run({ action }, captured);
      else setPhase({ step: "menu" });
    },
    [editor, enabled, run, showSelection],
  );

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!enabled && target) close();
  }, [enabled, target, close]);

  // Escape closes (and cancels); a click elsewhere closes while nothing is waiting to be kept.
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onDown = (event: MouseEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (phase.step !== "running" && phase.step !== "done") close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [target, phase.step, close]);

  useEffect(() => {
    if (target && phase.step === "menu") inputRef.current?.focus();
  }, [target, phase.step]);

  const apply = useCallback(
    async (how: "replace" | "below") => {
      if (!target || phase.step !== "done") return;
      const markdown = result.trim();
      const saved = await snapshotBeforeAiEditAction(pageId).catch(() => null);
      if (!saved?.ok) {
        setNotice(saved?.error ?? t("assistant.applyFailed"));
        return;
      }
      try {
        let placed = how;
        if (how === "replace") {
          const range = currentRange(editor, target);
          if (range) {
            const { state, view } = { state: editor.prosemirrorState, view: editor.prosemirrorView };
            view?.dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)));
            editor.pasteMarkdown(markdown);
          } else placed = "below";
        }
        if (placed === "below") insertBelow(editor, target.blockId, markdown, phase.action === "summarize");
        if (placed !== how) {
          setPhase({ step: "notice", message: t("assistant.selectionChanged") });
          showSelection(false);
          return;
        }
        close();
        editor.focus();
      } catch {
        setNotice(t("assistant.applyFailed"));
      }
    },
    [target, phase, result, pageId, editor, close, showSelection, t],
  );

  const languages = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {}
    return AI_LANGUAGES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);

  let panel: ReactNode = null;
  if (target) {
    const hasSelection = Boolean(target?.text);
    const top = Math.min(target.top, window.innerHeight - 120);
    const left = Math.max(8, Math.min(target.left, window.innerWidth - Math.min(PANEL_WIDTH, window.innerWidth - 16) - 8));
    const item = (key: EditorAction, icon: ReactNode, onClick: () => void) => (
      <button
        key={key}
        type="button"
        role="menuitem"
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-fg hover:bg-bg-hover"
      >
        <span className="flex h-4 w-4 items-center justify-center text-fg-muted">{icon}</span>
        {t(`assistant.actions.${key}`)}
      </button>
    );
    const start = (request: Request) => void run(request, target);
    panel = createPortal(
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t("assistant.label")}
        style={{ top, left, width: `min(${PANEL_WIDTH}px, calc(100vw - 16px))` }}
        className="fixed z-50 rounded-lg border border-border bg-bg text-sm shadow-lg"
        onMouseDown={(event) => {
          // Keep the editor's selection while clicking buttons in the panel.
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        }}
      >
        {phase.step === "notice" && (
          <div className="flex items-start gap-2 p-2">
            <p role="status" className="flex-1 px-1 py-0.5 text-fg-muted">
              {phase.message}
            </p>
            <PanelIconButton label={t("assistant.discard")} onClick={close}>
              <X className="h-3.5 w-3.5" />
            </PanelIconButton>
          </div>
        )}
        {phase.step === "menu" && (
          <>
            <form
              className="flex items-center gap-1 border-b border-border p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const text = instruction.trim();
                if (text) start({ action: "custom", instruction: text });
              }}
            >
              <Bot className="mx-1 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <input
                ref={inputRef}
                value={instruction}
                maxLength={1000}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={t(hasSelection ? "assistant.placeholderSelection" : "assistant.placeholder")}
                aria-label={t(hasSelection ? "assistant.placeholderSelection" : "assistant.placeholder")}
                className="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-faint"
              />
              <PanelIconButton label={t("assistant.send")} type="submit" disabled={!instruction.trim()}>
                <SendHorizontal className="h-3.5 w-3.5 rtl:-scale-x-100" />
              </PanelIconButton>
            </form>
            <div role="menu" className="p-1">
              {hasSelection && (
                <>
                  {item("improve", <PenLine className="h-3.5 w-3.5" />, () => start({ action: "improve" }))}
                  {item("fix", <CheckCheck className="h-3.5 w-3.5" />, () => start({ action: "fix" }))}
                  {item("shorten", <Minimize2 className="h-3.5 w-3.5" />, () => start({ action: "shorten" }))}
                  {item("translate", <Languages className="h-3.5 w-3.5" />, () => setPhase({ step: "language" }))}
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              {item("continue", <ListEnd className="h-3.5 w-3.5" />, () => start({ action: "continue" }))}
              {item("summarize", <FileText className="h-3.5 w-3.5" />, () => start({ action: "summarize" }))}
            </div>
          </>
        )}
        {phase.step === "language" && (
          <div className="p-1">
            <div className="flex items-center gap-1 px-1 pb-1">
              <PanelIconButton label={t("assistant.back")} onClick={() => setPhase({ step: "menu" })}>
                <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
              </PanelIconButton>
              <span className="text-xs text-fg-muted">{t("assistant.translateInto")}</span>
            </div>
            <div role="menu" className="grid max-h-64 grid-cols-2 overflow-y-auto">
              {languages.map((language) => (
                <button
                  key={language.code}
                  type="button"
                  role="menuitem"
                  onClick={() => start({ action: "translate", language: language.code })}
                  className="truncate rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  {language.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {(phase.step === "running" || phase.step === "done" || phase.step === "error") && (
          <div>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
              <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="flex-1 truncate">
                {phase.request.action === "translate" && phase.request.language
                  ? `${t("assistant.translateInto")} ${languages.find((l) => l.code === phase.request.language)?.name ?? ""}`
                  : phase.request.action === "custom"
                    ? phase.request.instruction
                    : t(`assistant.actions.${phase.request.action}`)}
              </span>
              {phase.step === "running" && <span aria-live="polite">{t("assistant.writing")}</span>}
            </div>
            {phase.step === "error" ? (
              <p role="alert" className="px-3 py-2 text-danger">
                {phase.message}
              </p>
            ) : (
              <div
                className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 leading-relaxed text-fg"
                aria-live="polite"
                aria-busy={phase.step === "running"}
              >
                {result || <span className="text-fg-faint">{t("assistant.writing")}</span>}
              </div>
            )}
            {phase.step === "done" && (
              <p className="px-3 pb-1 text-xs text-fg-faint">{t(phase.note === "cutOff" ? "assistant.cutOff" : phase.note === "stopped" ? "assistant.stopped" : "assistant.reviewNote")}</p>
            )}
            {notice && <p className="px-3 pb-1 text-xs text-danger">{notice}</p>}
            <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border p-1.5">
              {phase.step === "running" ? (
                <PanelButton onClick={() => abort.current?.abort()}>
                  <Square className="h-3 w-3" />
                  {t("assistant.stop")}
                </PanelButton>
              ) : (
                <>
                  <PanelButton onClick={close}>
                    <X className="h-3.5 w-3.5" />
                    {t("assistant.discard")}
                  </PanelButton>
                  <PanelButton onClick={() => start(phase.request)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("assistant.retry")}
                  </PanelButton>
                  {phase.step === "done" && (
                    <>
                      <PanelButton primary={!hasSelection || !SELECTION_RESULT.has(phase.action)} onClick={() => void apply("below")}>
                        <ListEnd className="h-3.5 w-3.5" />
                        {t("assistant.insertBelow")}
                      </PanelButton>
                      {hasSelection && SELECTION_RESULT.has(phase.action) && (
                        <PanelButton primary onClick={() => void apply("replace")}>
                          <Replace className="h-3.5 w-3.5" />
                          {t("assistant.replace")}
                        </PanelButton>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>,
      document.body,
    );
  }

  return { open, panel };
}

/** Actions whose answer stands in for the selection (the others write new text). */
const SELECTION_RESULT = new Set<EditorAction>(["improve", "shorten", "fix", "translate", "custom"]);

function PanelButton({ children, onClick, primary }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
        primary ? "bg-accent text-accent-fg hover:opacity-90" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function PanelIconButton({
  label,
  children,
  onClick,
  type = "button",
  disabled,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------------------ editor glue

function captureTarget(editor: PageEditor): Target | null {
  const view = editor.prosemirrorView;
  if (!view) return null;
  const state = editor.prosemirrorState;
  const selection = state.selection;
  const hasSelection = selection instanceof TextSelection && !selection.empty && state.doc.textBetween(selection.from, selection.to, "\n").trim() !== "";
  let text = "";
  let plain = "";
  let range: Target["range"] = null;
  let blocks: AnyBlock[] = [];
  if (hasSelection) {
    text = editor.blocksToMarkdownLossy(editor.getSelectionCutBlocks().blocks as never).trim();
    plain = state.doc.textBetween(selection.from, selection.to, "\n");
    blocks = (editor.getSelection()?.blocks ?? []) as AnyBlock[];
    const binding = ySyncPluginKey.getState(state)?.binding;
    try {
      range = binding
        ? {
            from: absolutePositionToRelativePosition(selection.from, binding.type, binding.mapping),
            to: absolutePositionToRelativePosition(selection.to, binding.type, binding.mapping),
          }
        : { from: selection.from, to: selection.to };
    } catch {
      range = { from: selection.from, to: selection.to };
    }
  }
  const block = (blocks.length ? blocks[blocks.length - 1] : editor.getTextCursorPosition().block) as AnyBlock;
  const top = topLevelOf(editor, block.id);
  const document = editor.document as AnyBlock[];
  const index = document.findIndex((b) => b.id === top);
  const before = editor.blocksToMarkdownLossy(document.slice(0, index + 1) as never).trim();
  const coords = view.coordsAtPos(hasSelection ? selection.to : selection.head);
  const start = view.coordsAtPos(hasSelection ? selection.from : selection.head);
  // The panel opens from where the text starts: its right edge there when the line runs right to left.
  const left = isRtl(view.dom) ? start.right - Math.min(PANEL_WIDTH, window.innerWidth - 16) : start.left;
  return { text, plain, range, before, blockId: block.id, top: coords.bottom + 8, left };
}

function topLevelOf(editor: PageEditor, id: string): string {
  let current = id;
  for (let i = 0; i < 100; i++) {
    const parent = editor.getParentBlock(current);
    if (!parent) return current;
    current = parent.id;
  }
  return current;
}

/** Where the selected text is now, or null when it moved away or someone changed it. */
function currentRange(editor: PageEditor, target: Target): { from: number; to: number } | null {
  if (!target.range) return null;
  const state = editor.prosemirrorState;
  let from: number | null;
  let to: number | null;
  if (typeof target.range.from === "number") {
    from = target.range.from;
    to = target.range.to as number;
  } else {
    const binding = ySyncPluginKey.getState(state)?.binding;
    if (!binding) return null;
    from = relativePositionToAbsolutePosition(binding.doc, binding.type, target.range.from, binding.mapping);
    to = relativePositionToAbsolutePosition(binding.doc, binding.type, target.range.to as RelativePosition, binding.mapping);
  }
  if (from === null || to === null || from >= to || to > state.doc.content.size) return null;
  if (state.doc.textBetween(from, to, "\n") !== target.plain) return null;
  return { from, to };
}

/**
 * Adds the answer after the block (in place of it when it's an empty line, like where the slash
 * menu was opened). A page summary of one paragraph goes into a callout.
 */
function insertBelow(editor: PageEditor, blockId: string, markdown: string, summary: boolean) {
  let blocks = editor.tryParseMarkdownToBlocks(markdown) as AnyBlock[];
  if (!blocks.length) return;
  if (summary && blocks.length === 1 && blocks[0].type === "paragraph") {
    blocks = [{ type: CALLOUT_BLOCK, content: blocks[0].content } as AnyBlock];
  }
  const anchor = editor.getBlock(blockId) as AnyBlock | undefined;
  const document = editor.document as AnyBlock[];
  if (!anchor) {
    editor.insertBlocks(blocks as never, document[document.length - 1], "after");
    return;
  }
  const empty = anchor.type === "paragraph" && Array.isArray(anchor.content) && anchor.content.length === 0 && !anchor.children.length;
  if (empty) editor.replaceBlocks([anchor], blocks as never);
  else editor.insertBlocks(blocks as never, anchor, "after");
}

// ------------------------------------------------------------------------------------ entries

/** "Ask AI" in the formatting toolbar (shown on a selection). */
export function AskAiToolbarButton({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations("ai.assistant");
  const Components = useComponentsContext()!;
  const toolbar = useExtension(FormattingToolbarExtension);
  return (
    <Components.FormattingToolbar.Button
      label={t("askAi")}
      mainTooltip={t("askAi")}
      icon={<Bot size={16} />}
      onClick={() => {
        onOpen();
        toolbar.store.setState(false);
      }}
    >
      <span className="inline-flex items-center gap-1 text-[13px]">
        <Bot size={16} />
        {t("askAi")}
      </span>
    </Components.FormattingToolbar.Button>
  );
}

/** Slash menu entries: Ask AI, Continue writing, Summarize page. */
export function useAiSlashItems(open: AiAssist["open"], enabled: boolean): DefaultReactSuggestionItem[] {
  const t = useTranslations("ai.assistant");
  return useMemo(() => {
    if (!enabled) return [];
    const group = t("group");
    return [
      {
        title: t("askAi"),
        subtext: t("askAiSubtext"),
        aliases: t("askAiAliases").split(" "),
        group,
        icon: <Bot size={18} />,
        // After the slash menu removed "/…" and put the cursor back.
        onItemClick: () => setTimeout(() => open()),
      },
      {
        title: t("actions.continue"),
        subtext: t("continueSubtext"),
        aliases: t("continueAliases").split(" "),
        group,
        icon: <ListEnd size={18} />,
        onItemClick: () => setTimeout(() => open("continue")),
      },
      {
        title: t("actions.summarize"),
        subtext: t("summarizeSubtext"),
        aliases: t("summarizeAliases").split(" "),
        group,
        icon: <FileText size={18} />,
        onItemClick: () => setTimeout(() => open("summarize")),
      },
    ];
  }, [open, enabled, t]);
}
