"use client";

import type { Editor } from "@tiptap/core";
import { Check, ChevronDown, ChevronLeft, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { discardDraftAction, saveDraftAction, sendMailAction, undoSendAction } from "@/app/actions/mail";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { showToast } from "@/components/toast";
import { Button, cn, IconButton, MenuItem, Popover } from "@/components/ui";
import {
  MAIL_DRAFT_HEAVY,
  MAIL_DRAFT_SAVE_MS,
  MAIL_DRAFT_SLOW_MS,
  MAIL_UNDO_SECONDS,
  MAX_COMPOSE_BYTES,
  type MailAttachmentView,
  type MailboxTabView,
  type MailDraftRef,
  type MailDraftView,
  type MailMessageView,
  type MailSendStatus,
  type MailUndoneSend,
} from "@/lib/mail-client";
import type { MailWriteAction } from "@/lib/mail-ai";
import { parseRecipient, showAddress, splitAddresses, startFrom, type ComposeMode, type ComposeSource, type Recipient } from "./compose-start";
import { FormatBar, MailEditorContent, pictureFiles, putPictures, putSignature, useMailEditor, writeBelow } from "./mail-editor";
import { MailFrame } from "./mail-frame";
import { MailboxMark } from "./mail-sidebar";
import { RecipientField } from "./recipient-field";

// The AI writer loads the first time it is opened.
const ComposerAi = lazyPart(() => import("./composer-ai").then((m) => m.ComposerAi));

/** A file of the message: one added here, or one its saved draft holds on the mail server (by its part there). */
type Attached = { file: File } | { stored: MailAttachmentView };

const sizeOf = (a: Attached) => ("file" in a ? a.file.size : Math.round(a.stored.size / 1.37));
const nameOf = (a: Attached) => ("file" in a ? a.file.name : a.stored.name);

/**
 * The editor's HTML as it is sent: its pictures shown from the browser written as the parts of the
 * message they go as (`cid:`), with the Content-IDs it shows.
 */
function withPictureIds(html: string) {
  if (!html.includes("data-cid")) return { html, cids: [] as string[] };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cids: string[] = [];
  for (const img of Array.from(doc.querySelectorAll("img[data-cid]"))) {
    const cid = img.getAttribute("data-cid")!;
    cids.push(cid);
    img.setAttribute("src", `cid:${cid}`);
    img.removeAttribute("data-cid");
  }
  return { html: doc.body.innerHTML, cids };
}

/** Asks how a message sent went once its Undo seconds are up, again while it is still going. */
function followSend(sendId: string, then: (status: MailSendStatus) => void, tries = 0) {
  setTimeout(
    () =>
      void read("mailSend", sendId)
        .then((result) => {
          if (!result.ok) return;
          if ((result.data.state === "held" || result.data.state === "sending") && tries < 30) return followSend(sendId, then, tries + 1);
          then(result.data);
        })
        .catch(() => {}),
    tries ? 2000 : MAIL_UNDO_SECONDS * 1000 + 1000,
  );
}

/**
 * Writes a message: a new one in the page's pane (`layout` "pane", from any of the person's
 * mailboxes), or an answer or forward of `source` under its thread (the server adds the thread's
 * references, and a forward's files). What is written is kept as a draft in the mailbox's drafts
 * folder a moment after each change and as the composer closes; `draft` opens one again.
 * Formatting is the editor's (mail-editor.tsx); sends with ⌘/Ctrl+Enter; files come from the
 * button or dropped on it. A message sent waits MAIL_UNDO_SECONDS on the server for Undo, which
 * makes it a draft again for `onUndone` to open; `onDelivered` follows once it went (or failed and
 * was kept as a draft). With `ai`, the AI writer (composer-ai.tsx) opens from beside the
 * formatting, or at once running `aiStart`.
 */
export function Composer({
  workspaceId,
  ai,
  aiStart = null,
  box,
  boxes = [box],
  mode,
  source,
  draft = null,
  layout,
  onSent,
  onClose,
  onSaved,
  onUndone,
  onDelivered,
}: {
  workspaceId: string;
  ai: boolean;
  aiStart?: MailWriteAction | null;
  box: MailboxTabView;
  boxes?: MailboxTabView[];
  mode: ComposeMode;
  source: ComposeSource | null;
  /** A saved draft opened to write on. */
  draft?: MailDraftView | null;
  layout: "pane" | "inline";
  onSent: () => void;
  onClose: () => void;
  /** Its draft was saved (its id in the index now: each save is a new message there) or thrown away (null); `open` while it still shows. */
  onSaved?: (id: string | null, open: boolean) => void;
  onUndone?: (draft: MailUndoneSend) => void;
  onDelivered?: () => void;
}) {
  const t = useTranslations("mail.composer");
  const tai = useTranslations("mail.ai");
  const locale = useLocale();
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const [initial] = useState(() => {
    if (draft) {
      return {
        to: draft.to as Recipient[],
        cc: draft.cc as Recipient[],
        bcc: draft.bcc as Recipient[],
        subject: draft.subject,
        html: draft.html,
        from: boxes.find((b) => b.id === draft.mailboxId) ?? box,
        files: draft.attachments.map((stored): Attached => ({ stored })),
        // The server takes the quote from the draft before (quote.ts): no header needed.
        quote: null as string[] | null,
      };
    }
    const start = startFrom(
      mode,
      box,
      source,
      (m) => t("replyHeader", { date: when(m.sentAt), name: m.from.name || m.from.address }),
      (m: MailMessageView) => [
        t("forwardedHeader"),
        `${t("from")}: ${showAddress(m.from)}`,
        `${t("date")}: ${when(m.sentAt)}`,
        `${t("subject")}: ${m.subject}`,
        `${t("to")}: ${m.to.map(showAddress).join(", ")}`,
      ],
    );
    return { ...start, from: box, bcc: [] as Recipient[], files: [] as Attached[] };
  });
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [files, setFiles] = useState(initial.files);
  // The earlier mail goes under what is written (the server adds it): shown folded, taken off on asking.
  const quotedFirst = draft ? !!draft.quote : !!initial.quote;
  const [quoted, setQuoted] = useState(quotedFirst);
  const [written, setWritten] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [writer, setWriter] = useState<{ start: MailWriteAction | null } | null>(ai && aiStart ? { start: aiStart } : null);
  const typed = useRef({ to: "", cc: "", bcc: "" });
  const html = useRef(initial.html);
  const fileInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  // Pictures put in the text, by Content-ID: each goes to the server once, with the first save that
  // shows it; after that it is carried over from the draft saved last (`savedPictures`).
  const pictures = useRef(new Map<string, File>());
  const savedPictures = useRef(new Set(withPictureIds(initial.html).cids));
  const picturesBytes = () => withPictureIds(editorRef.current?.getHTML() ?? "").cids.reduce((n, cid) => n + (pictures.current.get(cid)?.size ?? 0), 0);
  const editorRef = useRef<Editor | null>(null);
  const answering = mode === "reply" || mode === "replyAll";
  // The message it answers: the one under which it is written, or the one its draft answers.
  const replyTo = answering ? (source?.message.id ?? null) : (draft?.replyTo ?? null);
  const { editor, linking, setLinking } = useMailEditor({
    html: initial.html,
    placeholder: t("placeholder"),
    label: t("body"),
    autofocus: answering ? "start" : false,
    onChange: (e: Editor) => {
      html.current = e.getHTML();
      setWritten(true);
      changed();
    },
    onPictures: (list) => editorRef.current && putPictures(editorRef.current, list, null, (cid, file) => pictures.current.set(cid, file)),
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!answering) toInput.current?.focus();
  }, [answering]);

  // Drafts: saved MAIL_DRAFT_SAVE_MS after the last change, one save at a time, the last one as the
  // composer closes; sending waits for a save under way, and none starts after it.
  const done = useRef(false);
  const sendingNow = useRef(false);
  const savedDraft = useRef<{ id: string | null; messageId: string | null; mailboxId: string } | null>(draft ? { id: draft.id, messageId: draft.messageId, mailboxId: draft.mailboxId } : null);
  const edits = useRef(0);
  const savedEdits = useRef(0);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swapped = useRef(false);
  const mounted = useRef(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const touched = written || to !== initial.to || cc !== initial.cc || bcc !== initial.bcc || subject !== initial.subject || files !== initial.files || from !== initial.from || quoted !== quotedFirst;
  const latest = useRef({ from, to, cc, bcc, subject, files, quoted, touched });
  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(() => {
    latest.current = { from, to, cc, bcc, subject, files, quoted, touched };
  });

  /** What the fields hold, as the server takes it: addresses typed but not yet made recipients count when they are addresses. */
  const fieldsNow = (strict: boolean) => {
    const { to, cc, bcc } = latest.current;
    return [to, cc, bcc].map((list, i) => {
      const typedText = typed.current[(["to", "cc", "bcc"] as const)[i]];
      const all = [...list, ...splitAddresses(typedText).map(parseRecipient)];
      return strict ? all : all.filter((r) => !r.bad);
    });
  };

  /** The message as sent to the server: the draft it replaces, the files it keeps from it, the files added since. */
  const formOf = (fields: Recipient[][]) => {
    const { from, subject, files, quoted } = latest.current;
    const ref: MailDraftRef | null = savedDraft.current
      ? { ...savedDraft.current, keep: files.flatMap((f) => ("stored" in f ? [f.stored.part] : [])) }
      : null;
    const form = new FormData();
    const written = withPictureIds(editor?.isEmpty ? "" : (editor?.getHTML() ?? html.current));
    form.set(
      "draft",
      JSON.stringify({
        mailboxId: from.id,
        to: fields[0].map((r) => r.address),
        cc: fields[1].map((r) => r.address),
        bcc: fields[2].map((r) => r.address),
        subject,
        html: written.html,
        replyTo,
        forward: mode === "forward" ? (source?.message.id ?? null) : null,
        draft: ref,
        quote: quoted ? { header: initial.quote } : null,
      }),
    );
    const kept = files.filter((f): f is { stored: MailAttachmentView } => "stored" in f);
    const added = files.filter((f): f is { file: File } => "file" in f);
    for (const { file } of added) form.append("file", file);
    // A picture the draft saved last showed comes from there; others go now, if their file is here.
    for (const cid of written.cids) {
      const file = pictures.current.get(cid);
      if (!file || (savedDraft.current && savedPictures.current.has(cid))) continue;
      form.append("inline", file);
      form.append("inlineCid", cid);
    }
    return { form, kept, added, shown: written.cids };
  };

  /** Saves the draft now, after a save under way; nothing when nothing changed since the last. */
  const saveNow = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const run = saves.current.then(async () => {
      if (done.current || sendingNow.current || !latest.current.touched || savedEdits.current === edits.current) return;
      const at = edits.current;
      const { form, kept, added, shown } = formOf(fieldsNow(false));
      setSaveState("saving");
      const result = await saveDraftAction(form).catch(() => null);
      if (!result?.ok) return setSaveState("failed");
      savedDraft.current = { id: result.data.id, messageId: result.data.messageId, mailboxId: latest.current.from.id };
      savedPictures.current = new Set(shown);
      savedEdits.current = at;
      // The files sent now are on the server: they are kept from there from now on, in the order
      // they went (the files it kept, then the ones added), unless they were taken off meanwhile.
      const stored = result.data.attachments;
      if (stored.length === kept.length + added.length) {
        const swap = new Map<Attached, Attached>([...kept, ...added].map((a, i) => [a, { stored: stored[i] }]));
        // The same files, now from the server: no change to save again.
        swapped.current = true;
        setFiles((list) => list.map((a) => swap.get(a) ?? a));
      }
      setSaveState(done.current ? "idle" : "saved");
      saved.current?.(result.data.id, mounted.current);
    });
    saves.current = run.catch(() => {});
    return run;
  };
  function changed() {
    edits.current += 1;
    if (timer.current) clearTimeout(timer.current);
    const heavy = latest.current.files.reduce((n, f) => n + sizeOf(f), 0) + picturesBytes() > MAIL_DRAFT_HEAVY;
    timer.current = setTimeout(() => void saveNow(), heavy ? MAIL_DRAFT_SLOW_MS : MAIL_DRAFT_SAVE_MS);
  }

  // A change of the fields is a change to save (not their first values, nor files a save swapped).
  const first = useRef(true);
  useEffect(() => {
    if (first.current || swapped.current) {
      first.current = false;
      swapped.current = false;
      return;
    }
    changed();
    // changed reads everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cc, bcc, subject, files, quoted]);

  // Closing (another thread opened, the pane closed, the page left) saves what is not saved yet.
  useEffect(() => {
    mounted.current = true;
    const leave = () => void saveNow();
    const warn = (e: BeforeUnloadEvent) => {
      if (!done.current && latest.current.touched && savedEdits.current !== edits.current) e.preventDefault();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", warn);
      mounted.current = false;
      if (done.current || !latest.current.touched) return;
      void saveNow().then(() => savedDraft.current && showToast({ message: t("draftSaved") }));
    };
    // Once, for the composer's life: what it saves is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (then: () => void) => {
    done.current = true;
    if (timer.current) clearTimeout(timer.current);
    then();
  };

  async function send() {
    if (sending) return;
    const fields = fieldsNow(true);
    const bad = fields.flat().filter((r) => r.bad);
    if (bad.length) return setError(t("badAddress", { addresses: bad.map((r) => r.address).join(", ") }));
    if (!fields.some((f) => f.length)) return setError(t("needRecipient"));
    if (files.reduce((n, f) => n + sizeOf(f), 0) + picturesBytes() > MAX_COMPOSE_BYTES) return setError(t("tooLarge", { size: `${MAX_COMPOSE_BYTES / 1024 / 1024} MB` }));
    setError(null);
    setSending(true);
    sendingNow.current = true;
    if (timer.current) clearTimeout(timer.current);
    // A save under way finishes first: the message then takes its files from that draft.
    await saves.current;
    const { form } = formOf(fields);
    const result = await sendMailAction(form).catch(() => null);
    setSending(false);
    sendingNow.current = false;
    if (!result?.ok) return setError(result?.error ?? t("failed"));
    const { sendId } = result.data;
    showToast({
      message: t("sent"),
      undo: async () => {
        const undone = await undoSendAction(sendId).catch(() => null);
        if (!undone?.ok) return showToast({ message: undone?.error ?? t("failed") });
        if (!undone.data) return showToast({ message: t("alreadySent") });
        showToast({ message: t("sendUndone") });
        onUndone?.(undone.data);
      },
    });
    followSend(sendId, (status) => {
      if (status.state === "failed") showToast({ message: t("notSent", { reason: status.error ?? "" }) });
      if (status.state === "sent" || status.state === "failed") onDelivered?.();
    });
    finish(onSent);
  }

  /** Throws the message away, and its draft on the mail server. */
  function discard() {
    finish(onClose);
    // After a save under way, which may have made the draft.
    void saves.current.then(() => {
      const ref = savedDraft.current;
      if (!ref) return;
      void discardDraftAction({ ...ref, keep: [] }).then((result) => {
        if (result.ok) showToast({ message: t("draftDiscarded") });
        saved.current?.(null, false);
      });
    });
  }

  const pane = layout === "pane";
  const addFiles = (list: Iterable<File> | null | undefined) => setFiles((now) => [...now, ...Array.from(list ?? []).map((file): Attached => ({ file }))]);
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
      {(pane || mode === "forward" || (draft && !replyTo)) && (
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
        <li key={`${nameOf(file)}-${i}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-subtle ps-2 pe-1 text-sm">
          <Paperclip className="h-3.5 w-3.5 text-fg-icon" />
          <span className="max-w-48 truncate">{nameOf(file)}</span>
          <span className="text-xs text-fg-faint">{Math.max(1, Math.round(sizeOf(file) / 1024))} KB</span>
          <IconButton label={t("removeFile", { name: nameOf(file) })} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </li>
      ))}
    </ul>
  );

  const quotePart = quoted && (
    <QuotePreview
      html={draft ? draft.quote : source && initial.quote ? quoteOf(source, initial.quote, mode === "forward") : null}
      startOpen={mode === "forward"}
      onRemove={() => setQuoted(false)}
    />
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
      {saveState !== "idle" && (
        <span className={cn("text-xs", saveState === "failed" ? "text-danger" : "text-fg-faint")} role="status">
          {t(saveState === "saving" ? "draftSaving" : saveState === "saved" ? "draftSavedShort" : "draftFailed")}
        </span>
      )}
      <IconButton label={t("attach")} className="h-8 w-8 text-fg-icon" onClick={() => fileInput.current?.click()}>
        <Paperclip className="h-4 w-4" />
      </IconButton>
      <IconButton label={t("discard")} className="h-8 w-8 text-fg-icon" onClick={discard} disabled={sending}>
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
        // Escape closes, keeping what is written as a draft; the bin throws it away.
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          if (!sending) onClose();
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
        // Pictures dropped on the text go in it where they fall; other files, and pictures dropped
        // anywhere else, are attached.
        const all = Array.from(e.dataTransfer.files);
        const inText = editor && editor.view.dom.contains(e.target as Node) ? pictureFiles(all) : [];
        if (editor && inText.length) putPictures(editor, inText, editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null, (cid, file) => pictures.current.set(cid, file));
        addFiles(all.filter((f) => !inText.includes(f)));
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
            {quotePart}
            {attached}
          </div>
        </div>
      ) : (
        <>
          {fields}
          <div className="px-3 py-3">
            <MailEditorContent editor={editor} className="[&_.ProseMirror]:min-h-32" />
          </div>
          {quotePart && <div className="px-3">{quotePart}</div>}
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

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The earlier mail as the server will put it under an answer or a forward (server/mail-client/quote.ts):
 * the header lines, then the message read, its folded quote too, in a cited quote for an answer.
 */
function quoteOf({ message, body }: ComposeSource, header: string[], forward: boolean) {
  const inside = (html: string) => /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const original = body?.html
    ? inside(body.html) + (body.quotedHtml ? inside(body.quotedHtml) : "")
    : `<div style="white-space:pre-wrap">${escapeHtml(body?.text ?? message.preview)}</div>`;
  const head = `<p style="margin:0 0 8px">${header.map(escapeHtml).join("<br>")}</p>`;
  const quoted = forward ? `<div>${original}</div>` : `<blockquote type="cite">${original}</blockquote>`;
  const styles = body?.html ? (/<head[^>]*>[\s\S]*?<\/head>/i.exec(body.html)?.[0] ?? "") : "";
  return `<html>${styles}<body>${head}${quoted}</body></html>`;
}

/** The earlier mail under what is written: folded behind "•••", shown as it goes, and taken off on asking. */
function QuotePreview({ html, startOpen, onRemove }: { html: string | null; startOpen: boolean; onRemove: () => void }) {
  const t = useTranslations("mail.composer");
  const [open, setOpen] = useState(startOpen && !!html);
  return (
    <div className="pb-3">
      <div className="flex items-center gap-2">
        {html && (
          <button
            type="button"
            className="rounded border border-border px-1.5 text-xs text-fg-muted hover:bg-bg-hover"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={t(open ? "quoteHide" : "quoteShow")}
            title={t(open ? "quoteHide" : "quoteShow")}
          >
            •••
          </button>
        )}
        <button type="button" className="text-xs text-fg-muted hover:text-fg hover:underline" onClick={onRemove}>
          {t("quoteRemove")}
        </button>
      </div>
      {open && html && (
        <div className="mt-2 overflow-hidden rounded-md border border-border bg-white p-3">
          <MailFrame html={html} images={false} title={t("quoteShow")} />
        </div>
      )}
    </div>
  );
}

/** The pane's composer: a new message, or with `id` a saved draft, read from the mail server first. */
export function PaneComposer({ id, ...props }: Omit<Parameters<typeof Composer>[0], "draft" | "mode" | "source"> & { id: string | null }) {
  const t = useTranslations("mail");
  const [opened, setOpened] = useState<{ draft: MailDraftView | null; error: string | null }>({ draft: null, error: null });
  useEffect(() => {
    if (!id) return;
    let live = true;
    void read("mailDraft", id)
      .then((result) => live && setOpened(result.ok ? { draft: result.data, error: null } : { draft: null, error: result.error }))
      .catch(() => live && setOpened({ draft: null, error: t("loadFailed") }));
    return () => {
      live = false;
    };
  }, [id, t]);
  if (!id || opened.draft) return <Composer {...props} draft={opened.draft} mode="new" source={null} />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        <IconButton label={t("composer.close")} className="h-8 w-8 md:hidden" onClick={props.onClose}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
      </div>
      {opened.error ? (
        <p className="px-6 pt-6 text-sm text-fg-muted">{opened.error}</p>
      ) : (
        <div className="space-y-3 px-4 pt-4" aria-busy>
          {[40, 55, 90, 75].map((w) => (
            <div key={w} className="h-3.5 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}
