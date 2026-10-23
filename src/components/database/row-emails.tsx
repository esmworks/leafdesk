"use client";

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Paperclip } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { hideRowEmailAction, listRowEmailsAction, sendRowEmailAction } from "@/app/actions/row-mail";
import { Button, cn, Input, textareaClass } from "@/components/ui";
import { quoteText, replySubject, rowEmailFromHash, type RowEmailView } from "@/lib/mail";
import { relativeTime } from "@/lib/relative-time";
import type { RowEmailList } from "@/server/row-mail/list";
import { FollowUpList, StartFollowUp, useRowFollowUps } from "./follow-ups";

/** How long after sending the section looks again, to show a message going from queued to sent. */
const RECHECK_MS = [3_000, 15_000];

type Draft = { to: string; cc: string; subject: string; text: string; replyTo: string | null };

const splitAddresses = (value: string) =>
  value
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

/**
 * A row's email under its properties: the messages its people sent and were sent through members'
 * mailboxes, newest first, and, for whoever may edit the row and has a mailbox in the workspace, a
 * new message or a reply from it (plain text). Shows nothing to people who may not read the row's
 * mail, or where there is none and they can't write any.
 */
export function RowEmails({ rowId }: { rowId: string }) {
  const t = useTranslations("database.rowEmail");
  const tc = useTranslations("common");
  const [list, setList] = useState<RowEmailList | null>(null);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await listRowEmailsAction(rowId);
      if (mine !== seq.current) return;
      if (result.ok) setList(result.data);
      else setError(result.error);
    } catch {
      if (mine === seq.current) setError(tc("genericError"));
    }
  }, [rowId, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow-ups send from the section's mailbox: one that starts may send right away.
  const followUps = useRowFollowUps(rowId, () => {
    for (const ms of RECHECK_MS) setTimeout(() => void load(), ms);
  });

  // A link to one message (the inbox, a push notification) opens it.
  useEffect(() => {
    const id = rowEmailFromHash(window.location.hash);
    if (!id || !list?.emails.some((e) => e.id === id)) return;
    setOpen(true);
    setExpanded(id);
    requestAnimationFrame(() => document.getElementById(`email-${id}`)?.scrollIntoView({ block: "center" }));
  }, [list]);

  const loadMore = async () => {
    const last = list?.emails.at(-1);
    if (!list || !last) return;
    setLoadingMore(true);
    try {
      const result = await listRowEmailsAction(rowId, last.sentAt);
      if (result.ok && result.data) setList({ ...list, emails: [...list.emails, ...result.data.emails], more: result.data.more });
      else if (!result.ok) setError(result.error);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!list || (!list.emails.length && !list.canSend)) return null;

  const reply = (email: RowEmailView) => {
    const to = email.direction === "in" ? [email.from.address] : email.to;
    const header = t("quoteHeader", { name: email.from.name || email.from.address, date: new Date(email.sentAt).toLocaleString() });
    setDraft({ to: to.join(", "), cc: "", subject: replySubject(email.subject), text: `\n\n${quoteText(email.text, header)}`, replyTo: email.id });
  };

  return (
    <section className="mt-1 print:hidden" aria-label={t("title")}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-[30px] w-fit items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
          {t("title")}
          {list.emails.length > 0 && <span className="text-fg-faint tabular-nums">{list.more ? `${list.emails.length}+` : list.emails.length}</span>}
        </button>
        {open && list.canSend && !draft && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft({ to: list.addresses.join(", "), cc: "", subject: "", text: "", replyTo: null })}
          >
            {t("new")}
          </Button>
        )}
        {open && list.canSend && !draft && <StartFollowUp state={followUps} />}
      </div>
      {open && (
        <div className="mt-1 space-y-1 px-1">
          {draft && list.from && (
            <Compose
              rowId={rowId}
              from={list.from}
              draft={draft}
              onChange={setDraft}
              onClose={() => setDraft(null)}
              onSent={() => {
                setDraft(null);
                void load();
                for (const ms of RECHECK_MS) setTimeout(() => void load(), ms);
              }}
            />
          )}
          <FollowUpList state={followUps} />
          {list.emails.length === 0 && !draft && <p className="text-sm text-fg-faint">{t("empty")}</p>}
          <ol className="space-y-1">
            {list.emails.map((email) => (
              <Message
                key={email.id}
                email={email}
                expanded={expanded === email.id}
                onToggle={() => setExpanded((v) => (v === email.id ? null : email.id))}
                onReply={list.canSend ? () => reply(email) : undefined}
                onHidden={() => setList((l) => l && { ...l, emails: l.emails.filter((e) => e.id !== email.id) })}
              />
            ))}
          </ol>
          {list.more && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="h-7 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
            >
              {loadingMore ? tc("loading") : t("showMore")}
            </button>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </section>
  );
}

function Message({
  email,
  expanded,
  onToggle,
  onReply,
  onHidden,
}: {
  email: RowEmailView;
  expanded: boolean;
  onToggle: () => void;
  onReply?: () => void;
  onHidden: () => void;
}) {
  const t = useTranslations("database.rowEmail");
  const locale = useLocale();
  const format = useFormatter();
  const [error, setError] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const sender = email.direction === "out" && email.sentBy ? email.sentBy.name : email.from.name || email.from.address;
  const Arrow = email.direction === "in" ? ArrowDownLeft : ArrowUpRight;

  return (
    <li id={`email-${email.id}`} className={cn("rounded-lg border border-transparent", expanded && "border-border bg-bg-subtle/60")}>
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-bg-hover">
        <Arrow aria-label={t(email.direction === "in" ? "received" : "sent")} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-sm">
            <bdi className="truncate font-medium">{sender}</bdi>
            {email.status === "queued" && <span className="shrink-0 text-xs text-fg-muted">{t("queued")}</span>}
            {email.status === "failed" && <span className="shrink-0 text-xs text-danger">{t("failed")}</span>}
            {email.attachments.length > 0 && <Paperclip aria-label={t("attachments")} className="h-3 w-3 shrink-0 text-fg-faint" />}
          </span>
          <bdi className="block truncate text-sm">{email.subject || t("noSubject")}</bdi>
          {!expanded && <bdi className="block truncate text-xs text-fg-muted">{email.text.replace(/\s+/g, " ").slice(0, 200)}</bdi>}
        </span>
        <time dateTime={email.sentAt} title={format.dateTime(new Date(email.sentAt), { dateStyle: "medium", timeStyle: "short" })} className="shrink-0 pt-0.5 text-xs text-fg-faint">
          {relativeTime(email.sentAt, locale)}
        </time>
      </button>
      {expanded && (
        <div className="space-y-2 px-2 pb-2 ps-[1.875rem]">
          {email.unverifiedSender && (
            <p className="flex items-start gap-1.5 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("unverified", { address: email.from.address })}
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs text-fg-muted">
            <dt>{t("from")}</dt>
            <dd className="break-all">
              <bdi>{email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}</bdi>
            </dd>
            <dt>{t("to")}</dt>
            <dd className="break-all">{email.to.join(", ")}</dd>
            {email.cc.length > 0 && (
              <>
                <dt>{t("cc")}</dt>
                <dd className="break-all">{email.cc.join(", ")}</dd>
              </>
            )}
          </dl>
          {email.status === "failed" && email.error && <p className="text-xs text-danger">{t("failedReason", { reason: email.error })}</p>}
          <div className="max-h-[28rem] overflow-y-auto text-sm break-words whitespace-pre-wrap" dir="auto">
            {email.text || <span className="text-fg-faint">{t("noText")}</span>}
          </div>
          {email.attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {email.attachments.map((a) => (
                <li key={a.fileId}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-60 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs hover:bg-bg-hover"
                  >
                    <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                    <bdi className="truncate">{a.name}</bdi>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {onReply && (
              <Button size="sm" onClick={onReply}>
                {t("reply")}
              </Button>
            )}
            {email.canHide && (
              <Button
                size="sm"
                variant="ghost"
                disabled={hiding}
                onClick={async () => {
                  setHiding(true);
                  setError(null);
                  try {
                    const result = await hideRowEmailAction(email.id);
                    if (result.ok) onHidden();
                    else setError(result.error);
                  } finally {
                    setHiding(false);
                  }
                }}
              >
                {t("hide")}
              </Button>
            )}
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function Compose({
  rowId,
  from,
  draft,
  onChange,
  onClose,
  onSent,
}: {
  rowId: string;
  from: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useTranslations("database.rowEmail");
  const tc = useTranslations("common");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  return (
    <form
      className="space-y-2 rounded-lg border border-border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSending(true);
        setError(null);
        try {
          const result = await sendRowEmailAction(rowId, {
            to: splitAddresses(draft.to),
            cc: splitAddresses(draft.cc),
            subject: draft.subject,
            text: draft.text,
            replyTo: draft.replyTo,
          });
          if (result.ok) onSent();
          else setError(result.error);
        } catch {
          setError(tc("genericError"));
        } finally {
          setSending(false);
        }
      }}
    >
      <p className="text-xs text-fg-muted">{t("fromLine", { address: from })}</p>
      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs text-fg-muted">{t("to")}</span>
        <Input value={draft.to} required onChange={(e) => set({ to: e.target.value })} />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs text-fg-muted">{t("cc")}</span>
        <Input value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs text-fg-muted">{t("subject")}</span>
        <Input value={draft.subject} maxLength={900} onChange={(e) => set({ subject: e.target.value })} />
      </label>
      <textarea
        className={cn(textareaClass, "min-h-40")}
        value={draft.text}
        dir="auto"
        aria-label={t("body")}
        autoFocus
        onChange={(e) => set({ text: e.target.value })}
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={sending || !draft.to.trim() || (!draft.subject.trim() && !draft.text.trim())}>
          {sending ? t("sending") : t("send")}
        </Button>
      </div>
    </form>
  );
}
