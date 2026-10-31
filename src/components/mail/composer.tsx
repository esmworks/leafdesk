"use client";

import type { Editor } from "@tiptap/core";
import { Check, ChevronDown, ChevronLeft, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { sendMailAction } from "@/app/actions/mail";
import { lazyPart } from "@/components/lazy-part";
import { showToast } from "@/components/toast";
import { Button, cn, IconButton, MenuItem, Popover } from "@/components/ui";
import { MAX_COMPOSE_BYTES, type MailboxTabView, type MailMessageView } from "@/lib/mail-client";
import type { MailWriteAction } from "@/lib/mail-ai";
import { parseRecipient, showAddress, splitAddresses, startFrom, type ComposeMode, type ComposeSource, type Recipient } from "./compose-start";
import { FormatBar, MailEditorContent, putSignature, useMailEditor, writeBelow } from "./mail-editor";
import { MailboxMark } from "./mail-sidebar";
import { RecipientField } from "./recipient-field";

// The AI writer loads the first time it is opened.
const ComposerAi = lazyPart(() => import("./composer-ai").then((m) => m.ComposerAi));

/** A new message left unsent (the pane closed, another thread opened): it comes back as it was, until sent or discarded. */
type Kept = { fromId: string; to: Recipient[]; cc: Recipient[]; bcc: Recipient[]; subject: string; html: string; files: File[] };
let kept: Kept | null = null;

/**
 * Writes a message: a new one in the page's pane (`layout` "pane", from any of the person's
 * mailboxes), or an answer or forward of `source` under its thread (the server adds the thread's
 * references, and a forward's files). Formatting is the editor's (mail-editor.tsx); sends with
 * ⌘/Ctrl+Enter; files come from the button or dropped on it. With `ai`, the AI writer
 * (composer-ai.tsx) opens from beside the formatting, or at once running `aiStart`.
 */
export function Composer({
  workspaceId,
  ai,
  aiStart = null,
  box,
  boxes = [box],
  mode,
  source,
  layout,
  onSent,
  onClose,
}: {
  workspaceId: string;
  ai: boolean;
  aiStart?: MailWriteAction | null;
  box: MailboxTabView;
  boxes?: MailboxTabView[];
  mode: ComposeMode;
  source: ComposeSource | null;
  layout: "pane" | "inline";
  onSent: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("mail.composer");
  const tai = useTranslations("mail.ai");
  const locale = useLocale();
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const keeps = mode === "new";
  const [initial] = useState(() => {
    if (keeps && kept) return { ...kept, from: boxes.find((b) => b.id === kept!.fromId) ?? box, restored: true, headers: [] as string[] };
    const header = (m: MailMessageView) => t("replyHeader", { date: when(m.sentAt), name: m.from.name || m.from.address });
    const start = startFrom(mode, box, source, header, (m: MailMessageView) => [
      t("forwardedHeader"),
      `${t("from")}: ${showAddress(m.from)}`,
      `${t("date")}: ${when(m.sentAt)}`,
      `${t("subject")}: ${m.subject}`,
      `${t("to")}: ${m.to.map(showAddress).join(", ")}`,
    ]);
    // The first line of what is quoted under the message: the AI writer works above it.
    const headers = source ? [header(source.message), t("forwardedHeader")] : [];
    return { ...start, from: box, bcc: [] as Recipient[], files: [] as File[], restored: false, headers };
  });
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [files, setFiles] = useState(initial.files);
  const [written, setWritten] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [writer, setWriter] = useState<{ start: MailWriteAction | null } | null>(ai && aiStart ? { start: aiStart } : null);
  const typed = useRef({ to: "", cc: "", bcc: "" });
  const html = useRef(initial.html);
  const fileInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const answering = mode === "reply" || mode === "replyAll";
  const { editor, linking, setLinking } = useMailEditor({
    html: initial.html,
    placeholder: t("placeholder"),
    label: t("body"),
    autofocus: answering ? "start" : false,
    onChange: (e: Editor) => {
      html.current = e.getHTML();
      setWritten(true);
    },
  });

  useEffect(() => {
    if (!answering) toInput.current?.focus();
  }, [answering]);

  // What is written is kept as it changes, and dropped once sent or discarded.
  const done = useRef(false);
  const snapshot = useRef<Kept | null>(null);
  const touched = written || to !== initial.to || cc !== initial.cc || bcc !== initial.bcc || subject !== initial.subject || files !== initial.files || from !== initial.from;
  snapshot.current = keeps && (touched || initial.restored) ? { fromId: from.id, to, cc, bcc, subject, html: html.current, files } : null;
  useEffect(
    () => () => {
      if (keeps) kept = done.current ? null : snapshot.current;
    },
    [keeps],
  );
  const finish = (then: () => void) => {
    done.current = true;
    if (keeps) kept = null;
    then();
  };

  async function send() {
    if (sending) return;
    const fields = [to, cc, bcc].map((list, i) => {
      const text = typed.current[(["to", "cc", "bcc"] as const)[i]];
      return [...list, ...splitAddresses(text).map(parseRecipient)];
    });
    const bad = fields.flat().filter((r) => r.bad);
    if (bad.length) return setError(t("badAddress", { addresses: bad.map((r) => r.address).join(", ") }));
    if (!fields.some((f) => f.length)) return setError(t("needRecipient"));
    if (files.reduce((n, f) => n + f.size, 0) > MAX_COMPOSE_BYTES) return setError(t("tooLarge", { size: `${MAX_COMPOSE_BYTES / 1024 / 1024} MB` }));
    setError(null);
    setSending(true);
    const form = new FormData();
    form.set(
      "draft",
      JSON.stringify({
        mailboxId: from.id,
        to: fields[0].map((r) => r.address),
        cc: fields[1].map((r) => r.address),
        bcc: fields[2].map((r) => r.address),
        subject,
        html: editor?.isEmpty ? "" : (editor?.getHTML() ?? html.current),
        replyTo: answering ? source?.message.id : null,
        forward: mode === "forward" ? source?.message.id : null,
      }),
    );
    for (const file of files) form.append("file", file);
    const result = await sendMailAction(form).catch(() => null);
    setSending(false);
    if (!result?.ok) return setError(result?.error ?? t("failed"));
    showToast({ message: t("sent") });
    finish(onSent);
  }

  const pane = layout === "pane";
  const addFiles = (list: FileList | null | undefined) => setFiles((now) => [...now, ...Array.from(list ?? [])]);
  const ccToggles = (
    <span className="flex shrink-0 gap-1 pt-1">
      {!showCc && (
        <button type="button" className="rounded px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg" onClick={() => setShowCc(true)}>
          {t("cc")}
        </button>
      )}
      {!showBcc && (
        <button type="button" className="rounded px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg" onClick={() => setShowBcc(true)}>
          {t("bcc")}
        </button>
      )}
    </span>
  );

  const fields = (
    <div className={cn("divide-y divide-border border-b border-border", !pane && "px-3")}>
      {pane && boxes.length > 1 && (
        <div className="flex min-h-10 items-center gap-2 py-1.5">
          <span className="w-16 shrink-0 text-sm text-fg-muted">{t("from")}</span>
          <Popover
            wrapperClassName="min-w-0"
            trigger={({ toggle }) => (
              <button type="button" onClick={toggle} className="inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-bg-hover">
                <MailboxMark address={from.address} className="h-4 w-4 text-[10px]" />
                <span className="truncate">{from.displayName ? `${from.displayName} <${from.address}>` : from.address}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-icon" />
              </button>
            )}
          >
            {(close) =>
              boxes.map((b) => (
                <MenuItem
                  key={b.id}
                  icon={<MailboxMark address={b.address} className="h-4 w-4 text-[10px]" />}
                  trailing={b.id === from.id ? <Check className="h-3.5 w-3.5" /> : undefined}
                  onClick={() => {
                    if (editor && b.id !== from.id) putSignature(editor, b.signature, !from.signature);
                    setFrom(b);
                    close();
                  }}
                >
                  {b.address}
                </MenuItem>
              ))
            }
          </Popover>
        </div>
      )}
      <RecipientField label={t("to")} values={to} onChange={setTo} onTyped={(v) => (typed.current.to = v)} mailboxId={from.id} inputRef={toInput} trailing={ccToggles} />
      {showCc && <RecipientField label={t("cc")} values={cc} onChange={setCc} onTyped={(v) => (typed.current.cc = v)} mailboxId={from.id} />}
      {showBcc && <RecipientField label={t("bcc")} values={bcc} onChange={setBcc} onTyped={(v) => (typed.current.bcc = v)} mailboxId={from.id} />}
      {(pane || mode === "forward") && (
        <label className="flex min-h-10 items-center gap-2">
          <span className="w-16 shrink-0 text-sm text-fg-muted">{t("subject")}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" />
        </label>
      )}
    </div>
  );

  const attached = files.length > 0 && (
    <ul className={cn("flex flex-wrap gap-2 pb-3", !pane && "px-3")}>
      {files.map((file, i) => (
        <li key={`${file.name}-${i}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-subtle ps-2 pe-1 text-sm">
          <Paperclip className="h-3.5 w-3.5 text-fg-icon" />
          <span className="max-w-48 truncate">{file.name}</span>
          <span className="text-xs text-fg-faint">{Math.max(1, Math.round(file.size / 1024))} KB</span>
          <IconButton label={t("removeFile", { name: file.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </li>
      ))}
    </ul>
  );

  const footer = (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border py-2", pane ? "px-4" : "px-3")}>
      <Button variant="primary" onClick={() => void send()} disabled={sending} title={t("sendHint")}>
        <Send className="h-4 w-4" />
        {sending ? t("sending") : t("send")}
      </Button>
      {/* On a phone the formatting takes a line of its own under Send. */}
      {editor && (
        <div className="max-sm:order-last max-sm:w-full">
          <FormatBar editor={editor} linking={linking} setLinking={setLinking} />
        </div>
      )}
      {ai && editor && (
        <IconButton label={tai("write")} aria-pressed={!!writer} className={cn("h-8 w-8 text-fg-icon", writer && "bg-bg-active text-fg")} onClick={() => setWriter(writer ? null : { start: null })}>
          <Sparkles className="h-4 w-4" />
        </IconButton>
      )}
      <span className="flex-1" />
      <IconButton label={t("attach")} className="h-8 w-8 text-fg-icon" onClick={() => fileInput.current?.click()}>
        <Paperclip className="h-4 w-4" />
      </IconButton>
      <IconButton label={t("discard")} className="h-8 w-8 text-fg-icon" onClick={() => finish(onClose)} disabled={sending}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );

  return (
    <div
      className={cn(
        "relative flex flex-col bg-bg",
        pane ? "min-h-0 min-w-0 flex-1" : "rounded-lg border border-border shadow-[0_1px_2px_rgb(0_0_0/0.05)]",
      )}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
        // Escape closes only what has nothing written in it yet; the bin throws away the rest.
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          if (!sending && !touched) onClose();
        }
      }}
      onDragOverCapture={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDropCapture={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {pane && (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
          <IconButton label={t("close")} className="h-8 w-8 md:hidden" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate ps-1 text-sm font-medium">{subject.trim() || t("newTitle")}</h1>
          <IconButton label={t("close")} className="h-8 w-8 text-fg-icon max-md:hidden" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}
      {pane ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* As wide as the pane, lined up with its header and the bar under it. */}
          <div className="flex min-h-full flex-col px-4">
            {fields}
            <div className="flex flex-1 cursor-text flex-col py-4" onMouseDown={(e) => writeBelow(editor, e)}>
              <MailEditorContent editor={editor} className="flex flex-1 flex-col [&_.ProseMirror]:flex-1" />
            </div>
            {attached}
          </div>
        </div>
      ) : (
        <>
          {fields}
          <div className="px-3 py-3">
            <MailEditorContent editor={editor} className="[&_.ProseMirror]:min-h-32" />
          </div>
          {attached}
        </>
      )}
      {error && <p className={cn("pb-2 text-sm text-danger", pane ? "px-4" : "px-3")}>{error}</p>}
      {writer && editor && (
        <ComposerAi
          editor={editor}
          workspaceId={workspaceId}
          mailboxId={from.id}
          answering={source && mode !== "new" ? { id: source.message.id, reply: answering } : null}
          subject={subject}
          to={to.map((r) => r.name || r.address)}
          headers={initial.headers}
          start={writer.start}
          onClose={() => {
            setWriter(null);
            editor.commands.focus();
          }}
        />
      )}
      {footer}
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-accent bg-bg/80 text-sm font-medium text-accent">
          {t("dropFiles")}
        </div>
      )}
    </div>
  );
}
