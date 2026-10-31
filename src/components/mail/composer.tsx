"use client";

import { Paperclip, Send, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { sendMailAction } from "@/app/actions/mail";
import { showToast } from "@/components/toast";
import { Button, cn, IconButton, textareaClass } from "@/components/ui";
import { normalizeAddress, quoteText, replySubject } from "@/lib/mail";
import { forwardSubject, MAX_COMPOSE_BYTES, type MailAddress, type MailBody, type MailboxTabView, type MailMessageView } from "@/lib/mail-client";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";
export type ComposeSource = { message: MailMessageView; body: MailBody | null };

/** A recipient as a field shows it: a name with a comma or quote in it is quoted, so parseAddresses reads it back whole. */
const show = (a: MailAddress) => (!a.name ? a.address : /[,;"<>]/.test(a.name) ? `"${a.name.replace(/["\\]/g, "")}" <${a.address}>` : `${a.name} <${a.address}>`);

/** A field's text cut at commas, semicolons and new lines, but not inside quotes or angle brackets. */
function splitAddresses(value: string) {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let angled = false;
  for (const ch of value) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (!quoted && !angled && (ch === "," || ch === ";" || ch === "\n")) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The addresses of a field's text: commas, semicolons or new lines between them, "Name <address>" or the bare address. */
function parseAddresses(value: string) {
  const parts = splitAddresses(value);
  const good: string[] = [];
  const bad: string[] = [];
  for (const part of parts) {
    const inside = /<([^>]+)>\s*$/.exec(part)?.[1] ?? part;
    const address = normalizeAddress(inside);
    if (address) good.push(address);
    else bad.push(part);
  }
  return { good, bad };
}

/** What a reply, reply-all or forward starts with. */
function startFrom(mode: ComposeMode, box: MailboxTabView, source: ComposeSource | null, header: (m: MailMessageView) => string, forwarded: (m: MailMessageView) => string) {
  if (!source || mode === "new") return { to: "", cc: "", subject: "", text: "" };
  const { message, body } = source;
  const text = body?.text ?? message.preview;
  if (mode === "forward") return { to: "", cc: "", subject: forwardSubject(message.subject), text: `\n\n${forwarded(message)}\n${text}` };
  const mine = message.from.address === box.address;
  const replyTo = body?.replyTo.length ? body.replyTo : null;
  const to = mine ? message.to : (replyTo ?? [message.from]);
  const taken = new Set([box.address, ...to.map((a) => a.address)]);
  const cc = mode === "replyAll" ? [...message.to, ...message.cc].filter((a) => !taken.has(a.address) && (taken.add(a.address), true)) : [];
  return { to: to.map(show).join(", "), cc: cc.map(show).join(", "), subject: replySubject(message.subject), text: `\n\n${quoteText(text, header(message))}` };
}

/**
 * Writes a message from the open mailbox: a new one, or an answer or forward of `source` (the
 * server adds the thread's references, and a forward's files). Sends with ⌘/Ctrl+Enter.
 */
export function Composer({
  box,
  mode,
  source,
  onSent,
  onCancel,
  autoFocus = true,
  className,
}: {
  box: MailboxTabView;
  mode: ComposeMode;
  source: ComposeSource | null;
  onSent: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useTranslations("mail.composer");
  const locale = useLocale();
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const [initial] = useState(() =>
    startFrom(
      mode,
      box,
      source,
      (m) => t("replyHeader", { date: when(m.sentAt), name: m.from.name || m.from.address }),
      (m) =>
        [
          t("forwardedHeader"),
          `${t("from")}: ${show(m.from)}`,
          `${t("date")}: ${when(m.sentAt)}`,
          `${t("subject")}: ${m.subject}`,
          `${t("to")}: ${m.to.map(show).join(", ")}`,
          "",
        ].join("\n"),
    ),
  );
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(initial.subject);
  const [text, setText] = useState(initial.text);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const toInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    if (mode === "reply" || mode === "replyAll") {
      body.current?.focus();
      body.current?.setSelectionRange(0, 0);
    } else toInput.current?.focus();
  }, [autoFocus, mode]);

  async function send() {
    if (sending) return;
    const fields = [parseAddresses(to), parseAddresses(cc), parseAddresses(bcc)];
    const bad = fields.flatMap((f) => f.bad);
    if (bad.length) return setError(t("badAddress", { addresses: bad.join(", ") }));
    if (!fields.some((f) => f.good.length)) return setError(t("needRecipient"));
    if (files.reduce((n, f) => n + f.size, 0) > MAX_COMPOSE_BYTES) return setError(t("tooLarge", { size: `${MAX_COMPOSE_BYTES / 1024 / 1024} MB` }));
    setError(null);
    setSending(true);
    const form = new FormData();
    form.set(
      "draft",
      JSON.stringify({
        mailboxId: box.id,
        to: fields[0].good,
        cc: fields[1].good,
        bcc: fields[2].good,
        subject,
        text,
        replyTo: mode === "reply" || mode === "replyAll" ? source?.message.id : null,
        forward: mode === "forward" ? source?.message.id : null,
      }),
    );
    for (const file of files) form.append("file", file);
    const result = await sendMailAction(form).catch(() => null);
    setSending(false);
    if (!result?.ok) return setError(result?.error ?? t("failed"));
    showToast({ message: t("sent") });
    onSent();
  }

  const touched = to !== initial.to || cc !== initial.cc || !!bcc || subject !== initial.subject || text !== initial.text || files.length > 0;
  const field = "min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-fg-faint";
  return (
    <div
      className={cn("flex flex-col rounded-lg border border-border bg-bg", className)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
        // Escape closes only what has nothing written in it yet; Discard throws away the rest.
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!sending && !touched) onCancel();
        }
      }}
    >
      <div className="divide-y divide-border border-b border-border px-3">
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-sm text-fg-muted">{t("to")}</span>
          <input ref={toInput} value={to} onChange={(e) => setTo(e.target.value)} className={field} placeholder={t("toPlaceholder")} autoComplete="email" />
          {!showCc && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setShowCc(true)}>
              {t("cc")}
            </button>
          )}
          {!showBcc && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setShowBcc(true)}>
              {t("bcc")}
            </button>
          )}
        </label>
        {showCc && (
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-sm text-fg-muted">{t("cc")}</span>
            <input value={cc} onChange={(e) => setCc(e.target.value)} className={field} />
          </label>
        )}
        {showBcc && (
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-sm text-fg-muted">{t("bcc")}</span>
            <input value={bcc} onChange={(e) => setBcc(e.target.value)} className={field} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-sm text-fg-muted">{t("subject")}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
        </label>
      </div>
      <textarea
        ref={body}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={t("body")}
        className={cn(textareaClass, "min-h-48 resize-y rounded-none border-0 px-3 py-2.5 text-sm leading-relaxed focus:border-0")}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-3 pb-2">
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border border-border py-1 ps-2 pe-1 text-sm">
              <Paperclip className="h-3.5 w-3.5 text-fg-icon" />
              <span className="max-w-48 truncate">{file.name}</span>
              <IconButton label={t("removeFile", { name: file.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="px-3 pb-2 text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button variant="primary" onClick={() => void send()} disabled={sending}>
          <Send className="h-4 w-4" />
          {sending ? t("sending") : t("send")}
        </Button>
        <IconButton label={t("attach")} className="h-8 w-8" onClick={() => fileInput.current?.click()}>
          <Paperclip className="h-4 w-4" />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <span className="flex-1 text-xs text-fg-faint">{t("sendHint")}</span>
        <Button onClick={onCancel} disabled={sending}>
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}
