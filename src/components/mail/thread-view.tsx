"use client";

import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ChevronLeft,
  Database,
  Forward,
  Image as ImageIcon,
  Inbox,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { useRowPanel } from "@/components/database/row-panel-context";
import { read } from "@/components/read";
import { Button, cn, IconButton, PageIcon } from "@/components/ui";
import { pagePath } from "@/lib/mentions";
import type { MailAction, MailAddress, MailBody, MailboxTabView, MailFolderView, MailMessageView, MailThreadView } from "@/lib/mail-client";
import { initialOf, textOn, userColor } from "@/lib/presence";
import { Composer, type ComposeMode } from "./composer";
import { MailFrame } from "./mail-frame";

/** A sender's letter, in the color an address always gets (as people's avatars elsewhere). */
function Avatar({ who }: { who: MailAddress }) {
  const color = userColor(who.address);
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium" style={{ background: color, color: textOn(color) }}>
      {initialOf(who.name || who.address)}
    </span>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/** Plain text with its links made links, its quoted earlier mail folded away until asked for. */
function TextBody({ text }: { text: string }) {
  const t = useTranslations("mail");
  const [quoted, setQuoted] = useState(false);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Where the quoted part starts: the "On … wrote:" line before the first run of ">" lines, or the first of them.
  let cut = lines.findIndex((line) => /^\s*>/.test(line));
  if (cut > 0 && /:\s*$/.test(lines[cut - 1] ?? "")) cut -= 1;
  const shown = cut >= 0 && !quoted ? lines.slice(0, cut) : lines;
  const linked = (line: string) => {
    const out: ReactNode[] = [];
    let at = 0;
    for (const match of line.matchAll(URL_RE)) {
      out.push(line.slice(at, match.index));
      out.push(
        <a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
          {match[0]}
        </a>,
      );
      at = (match.index ?? 0) + match[0].length;
    }
    out.push(line.slice(at));
    return out;
  };
  return (
    <div className="text-[15px] leading-relaxed">
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {shown.map((line, i) => (
          <Fragment key={i}>
            <span className={cn(/^\s*>/.test(line) && "text-fg-muted")}>{linked(line)}</span>
            {i < shown.length - 1 && "\n"}
          </Fragment>
        ))}
      </div>
      {cut >= 0 && !quoted && (
        <button type="button" className="mt-2 rounded border border-border px-1.5 text-xs text-fg-muted hover:bg-bg-hover" onClick={() => setQuoted(true)} aria-label={t("quoted")} title={t("quoted")}>
          •••
        </button>
      )}
    </div>
  );
}

function useWhen() {
  const locale = useLocale();
  return (iso: string, long = false) => {
    const date = new Date(iso);
    const now = new Date();
    if (long) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
    if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
    if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
    return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
  };
}
export { useWhen };

type Loaded = { body: MailBody | null; images: boolean; error: string | null; loading: boolean };

function Message({
  message,
  box,
  open,
  loaded,
  onToggle,
  onImages,
  last,
  onCompose,
}: {
  message: MailMessageView;
  box: MailboxTabView;
  open: boolean;
  loaded: Loaded | undefined;
  onToggle: () => void;
  onImages: () => void;
  last: boolean;
  onCompose: (mode: ComposeMode) => void;
}) {
  const t = useTranslations("mail");
  const when = useWhen();
  const me = message.from.address === box.address;
  const name = (a: MailAddress) => (a.address === box.address ? t("me") : a.name || a.address);
  if (!open) {
    return (
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 border-b border-border px-6 py-3 text-start hover:bg-bg-hover">
        <Avatar who={message.from} />
        <span className="w-36 shrink-0 truncate text-sm font-medium">{me ? t("me") : message.from.name || message.from.address}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg-faint">{message.preview}</span>
        <span className="shrink-0 text-xs text-fg-faint">{when(message.sentAt)}</span>
      </button>
    );
  }
  const body = loaded?.body;
  return (
    <article className={cn("px-6 py-5", !last && "border-b border-border")}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 text-start">
        <Avatar who={message.from} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{message.from.name || message.from.address}</span>
            {message.from.name && <span className="truncate text-sm text-fg-faint max-sm:hidden">{message.from.address}</span>}
            <span className="flex-1" />
            <span className="shrink-0 text-xs text-fg-faint" title={when(message.sentAt, true)}>
              {when(message.sentAt, true)}
            </span>
          </div>
          <div className="truncate text-xs text-fg-muted">
            {t("toLine", { names: message.to.map(name).join(", ") || "—" })}
            {message.cc.length > 0 && ` · ${t("ccLine", { names: message.cc.map(name).join(", ") })}`}
          </div>
        </div>
      </button>
      {body?.unverifiedSender && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          {t("unverified")}
        </p>
      )}
      <div className="mt-4">
        {loaded?.loading && !body ? (
          <div className="space-y-2" aria-busy>
            {[90, 75, 82, 40].map((w) => (
              <div key={w} className="h-3.5 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : loaded?.error ? (
          <p className="text-sm text-fg-muted">{loaded.error}</p>
        ) : body ? (
          <>
            {body.blockedImages > 0 && !loaded?.images && (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                <ImageIcon className="h-4 w-4 text-fg-icon" />
                <span>{t("imagesBlocked", { count: body.blockedImages })}</span>
                <button type="button" className="font-medium text-accent hover:underline" onClick={onImages}>
                  {t("showImages")}
                </button>
              </div>
            )}
            {body.html ? <MailFrame html={body.html} images={!!loaded?.images} title={message.subject} /> : <TextBody text={body.text} />}
            {body.attachments.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label={t("attachments", { count: body.attachments.length })}>
                {body.attachments.map((file) => (
                  <li key={file.part}>
                    <a
                      href={`/api/mail/attachment?m=${encodeURIComponent(message.id)}&p=${encodeURIComponent(file.part)}`}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex max-w-72 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-bg-hover"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-fg-icon" />
                      <span className="truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-fg-faint">{formatSize(file.size)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {body.unsubscribe && (
              <a href={body.unsubscribe} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-xs text-fg-muted hover:underline">
                {t("unsubscribe")}
              </a>
            )}
          </>
        ) : null}
      </div>
      {last && body && (
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => onCompose("reply")}>
            <Reply className="h-4 w-4 text-fg-icon" />
            {t("actions.reply")}
          </Button>
          {message.to.length + message.cc.length > 1 && (
            <Button onClick={() => onCompose("replyAll")}>
              <ReplyAll className="h-4 w-4 text-fg-icon" />
              {t("actions.replyAll")}
            </Button>
          )}
          <Button onClick={() => onCompose("forward")}>
            <Forward className="h-4 w-4 text-fg-icon" />
            {t("actions.forward")}
          </Button>
        </div>
      )}
    </article>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The thread open beside the list: its messages, the row its other party is, and answering. */
export function ThreadView({
  workspaceId,
  box,
  folder,
  threadId,
  starred,
  onAction,
  onBack,
  onRead,
  compose,
  onComposeChange,
  onSent,
}: {
  workspaceId: string;
  box: MailboxTabView;
  folder: MailFolderView;
  threadId: string;
  starred: boolean;
  onAction: (action: MailAction) => void;
  onBack: () => void;
  /** A message was opened that wasn't read: the list and the counts follow. */
  onRead: () => void;
  compose: ComposeMode | null;
  onComposeChange: (mode: ComposeMode | null) => void;
  onSent: () => void;
}) {
  const t = useTranslations("mail");
  const router = useRouter();
  const rowPanel = useRowPanel();
  const [thread, setThread] = useState<MailThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [bodies, setBodies] = useState<Record<string, Loaded>>({});
  const [version, setVersion] = useState(0);

  const loadBody = useCallback(
    (message: MailMessageView, images = false) => {
      setBodies((b) => ({ ...b, [message.id]: { body: b[message.id]?.body ?? null, images, error: null, loading: true } }));
      void read("mailBody", { id: message.id, images })
        .then((result) => {
          setBodies((b) => ({ ...b, [message.id]: result.ok ? { body: result.data, images, error: null, loading: false } : { body: null, images, error: result.error, loading: false } }));
          if (result.ok && !message.seen) onRead();
        })
        .catch(() => setBodies((b) => ({ ...b, [message.id]: { body: null, images, error: t("loadFailed"), loading: false } })));
    },
    [onRead, t],
  );

  useEffect(() => {
    let live = true;
    setError(null);
    void read("mailThread", { mailboxId: box.id, threadId, folderId: folder.id })
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setThread(result.data);
        const messages = result.data.messages;
        // The newest message opens, and the ones not read yet.
        const opened = new Set(messages.filter((m, i) => i === messages.length - 1 || !m.seen).map((m) => m.id));
        setOpen(opened);
        for (const m of messages) if (opened.has(m.id)) loadBody(m);
      })
      .catch(() => live && setError(t("loadFailed")));
    return () => {
      live = false;
    };
    // loadBody changes with onRead; the thread is read again only when it is another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.id, threadId, folder.id, version]);

  const toggle = (message: MailMessageView) => {
    const next = new Set(open);
    if (next.has(message.id)) next.delete(message.id);
    else {
      next.add(message.id);
      if (!bodies[message.id]?.body) loadBody(message);
    }
    setOpen(next);
  };

  const last = thread?.messages[thread.messages.length - 1] ?? null;
  const moves: { action: MailAction; icon: ReactNode }[] =
    folder.role === "trash" || folder.role === "junk"
      ? [
          { action: "inbox", icon: <Inbox className="h-4 w-4" /> },
          { action: "delete", icon: <Trash2 className="h-4 w-4" /> },
        ]
      : [
          ...(folder.role === "archive" ? [{ action: "inbox" as const, icon: <Inbox className="h-4 w-4" /> }] : [{ action: "archive" as const, icon: <Archive className="h-4 w-4" /> }]),
          { action: "trash", icon: <Trash2 className="h-4 w-4" /> },
          { action: "junk", icon: <AlertOctagon className="h-4 w-4" /> },
        ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        <IconButton label={t("actions.back")} className="h-8 w-8 md:hidden" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        {moves.map(({ action, icon }) => (
          <IconButton key={action} label={t(`actions.${action}`)} className="h-8 w-8 text-fg-icon" onClick={() => onAction(action)}>
            {icon}
          </IconButton>
        ))}
        <IconButton label={t(starred ? "actions.unstar" : "actions.star")} className="h-8 w-8 text-fg-icon" onClick={() => onAction(starred ? "unstar" : "star")}>
          <Star className={cn("h-4 w-4", starred && "fill-current text-amber-500")} />
        </IconButton>
        <IconButton label={t("actions.unread")} className="h-8 w-8 text-fg-icon" onClick={() => onAction("unread")}>
          <MailOpen className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {error ? (
          <p className="px-6 pt-6 text-sm text-fg-muted">{error}</p>
        ) : !thread ? (
          <div className="space-y-3 px-6 pt-6" aria-busy>
            <div className="h-6 w-2/3 animate-pulse rounded bg-bg-hover" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-bg-hover" />
          </div>
        ) : (
          <>
            <div className="px-6 pt-5">
              <h2 className="text-xl leading-snug font-semibold [overflow-wrap:anywhere]">{thread.subject || t("noSubject")}</h2>
              <div className="mt-1 text-sm text-fg-muted">{t("messages", { count: thread.messages.length })}</div>
            </div>
            {thread.row && (
              <div className="mx-6 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                <Database className="h-4 w-4 shrink-0 text-fg-icon" />
                <span className="text-fg-muted">{t("onRow")}</span>
                <a
                  href={pagePath(workspaceId, thread.row.rowId)}
                  className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline"
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    if (rowPanel?.available) rowPanel.open(thread.row!.rowId, { source: null, trigger: e.currentTarget });
                    else router.push(pagePath(workspaceId, thread.row!.rowId));
                  }}
                >
                  <PageIcon icon={thread.row.icon} kind="page" className="h-4 w-4" />
                  <span className="truncate">{thread.row.title || t("untitledRow")}</span>
                </a>
              </div>
            )}
            <div className="mt-4 border-t border-border">
              {thread.messages.map((m) => (
                <Message
                  key={m.id}
                  message={m}
                  box={box}
                  open={open.has(m.id)}
                  loaded={bodies[m.id]}
                  onToggle={() => toggle(m)}
                  onImages={() => loadBody(m, true)}
                  last={m.id === last?.id}
                  onCompose={onComposeChange}
                />
              ))}
            </div>
            {compose && last && (
              <div className="px-6 pt-2">
                <Composer
                  key={`${compose}-${last.id}`}
                  box={box}
                  mode={compose}
                  source={{ message: last, body: bodies[last.id]?.body ?? null }}
                  onCancel={() => onComposeChange(null)}
                  onSent={() => {
                    onComposeChange(null);
                    onSent();
                    // The sent copy reaches the thread with the next read of the sent folder.
                    setTimeout(() => setVersion((v) => v + 1), 4000);
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
