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
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { streamAi } from "@/components/ai-stream";
import { useRowPanel } from "@/components/database/row-panel-context";
import { read } from "@/components/read";
import { Button, cn, IconButton, PageIcon } from "@/components/ui";
import { quoteStart } from "@/lib/mail-quote";
import { isAiErrorCode } from "@/lib/ai";
import type { MailWriteAction } from "@/lib/mail-ai";
import { pagePath } from "@/lib/mentions";
import type { MailAction, MailAddress, MailBody, MailboxTabView, MailFolderView, MailMessageView, MailThreadView } from "@/lib/mail-client";
import { initialOf, textOn, userColor } from "@/lib/presence";
import { lazyPart } from "@/components/lazy-part";
import { type ComposeMode, replyAllAdds } from "./compose-start";
import { forgetImageSenderAction, trustImageSenderAction } from "@/app/actions/mail";
import { cachedBody, cachedThread, forgetBodies, keepBody, keepThread } from "./mail-cache";
import { MailFrame } from "./mail-frame";
import { useWhen } from "./mail-store";

// The editor loads the first time an answer is written.
const Composer = lazyPart(() => import("./composer").then((m) => m.Composer));

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
  const cut = quoteStart(lines);
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


/** What opening a thread opens: its newest message, and the ones not read yet. */
function opensFirst(thread: MailThreadView) {
  const messages = thread.messages;
  return new Set(messages.filter((m, i) => i === messages.length - 1 || !m.seen).map((m) => m.id));
}

type Loaded = { body: MailBody | null; error: string | null; loading: boolean };

function Message({
  message,
  box,
  open,
  loaded,
  onToggle,
  onImages,
  onTrust,
  last,
  ai,
  onCompose,
}: {
  message: MailMessageView;
  box: MailboxTabView;
  open: boolean;
  loaded: Loaded | undefined;
  onToggle: () => void;
  onImages: () => void;
  /** Always shows images from the sender, or stops. */
  onTrust: (trust: boolean) => void;
  last: boolean;
  ai: boolean;
  /** Opens the composer; with `start`, its AI writer too, doing that at once. */
  onCompose: (mode: ComposeMode, start?: MailWriteAction) => void;
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
  const allowReplyAll = replyAllAdds(box, message);
  return (
    <article className={cn("px-6 py-5", !last && "border-b border-border")}>
      <div className="flex items-start gap-1">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-3 text-start">
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
        {/* Answers to this message, at hand without scrolling past it. */}
        <div className="-me-1.5 -mt-1 ms-2 flex shrink-0 items-center">
          <IconButton label={t("actions.reply")} className="h-8 w-8 text-fg-icon" onClick={() => onCompose("reply")}>
            <Reply className="h-4 w-4" />
          </IconButton>
          {allowReplyAll && (
            <IconButton label={t("actions.replyAll")} className="h-8 w-8 text-fg-icon" onClick={() => onCompose("replyAll")}>
              <ReplyAll className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton label={t("actions.forward")} className="h-8 w-8 text-fg-icon" onClick={() => onCompose("forward")}>
            <Forward className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      {body?.unverifiedSender && (
        <p className="mt-3 flex sm:ms-11 items-start gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          {t("unverified")}
        </p>
      )}
      <div className="mt-4 sm:ps-11">
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
            {body.blockedImages > 0 && !body.images && (
              <div className="mb-3 flex items-start gap-2 text-sm text-fg-muted">
                <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-fg-icon" />
                <div className="min-w-0 flex-1">
                  <p>{t("imagesBlocked", { count: body.blockedImages })}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    <button type="button" className="font-medium text-accent hover:underline" onClick={onImages}>
                      {t("showImages")}
                    </button>
                    {/* Trust needs the provider to vouch for the sender: a forged one would ride on it. */}
                    {!me && !body.unverifiedSender && (
                      <button type="button" className="font-medium text-accent hover:underline" onClick={() => onTrust(true)}>
                        {t("alwaysShowImages")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {body.images === "sender" && (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                <ImageIcon className="h-4 w-4 shrink-0 text-fg-icon" />
                <span>{t("imagesTrusted")}</span>
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => onTrust(false)}>
                  {t("stopImages")}
                </button>
              </div>
            )}
            {body.html ? <MailFrame html={body.html} images={!!body.images} title={message.subject} /> : <TextBody text={body.text} />}
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
        <div className="mt-6 flex flex-wrap gap-2 sm:ps-11">
          <Button onClick={() => onCompose("reply")}>
            <Reply className="h-4 w-4 text-fg-icon" />
            {t("actions.reply")}
          </Button>
          {allowReplyAll && (
            <Button onClick={() => onCompose("replyAll")}>
              <ReplyAll className="h-4 w-4 text-fg-icon" />
              {t("actions.replyAll")}
            </Button>
          )}
          <Button onClick={() => onCompose("forward")}>
            <Forward className="h-4 w-4 text-fg-icon" />
            {t("actions.forward")}
          </Button>
          {ai && (
            <Button onClick={() => onCompose("reply", "reply")}>
              <Sparkles className="h-4 w-4 text-fg-icon" />
              {t("ai.replyWithAi")}
            </Button>
          )}
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

type Summary = { text: string; messageId: string; running: boolean; error: string | null };

/**
 * The thread's AI summary: the one saved with it, or one asked for now, streamed in as it is written
 * (server/mail-client/ai.ts) and kept with the thread once done.
 */
function useSummary(mailboxId: string, folderId: string, threadId: string, thread: MailThreadView | null, setThread: (thread: MailThreadView) => void) {
  const t = useTranslations("mail");
  const ta = useTranslations("ai");
  const locale = useLocale();
  const [asked, setAsked] = useState<Summary | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const latest = useRef(thread);
  latest.current = thread;

  const run = useCallback(async () => {
    const newest = latest.current?.messages.at(-1);
    if (!newest) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let text = "";
    const show = (next: Partial<Summary>) => setAsked({ text, messageId: newest.id, running: true, error: null, ...next });
    show({});
    try {
      const ended = await streamAi(
        "/api/ai/mail",
        { kind: "summary", mailboxId, folderId, threadId, language: locale },
        {
          signal: controller.signal,
          onText: (piece) => {
            text += piece;
            show({});
          },
        },
      );
      if (!ended.ok) return show({ running: false, error: ended.code === "mail" ? t("ai.mailFailed") : ta(`errors.${isAiErrorCode(ended.code) ? ended.code : "provider"}`) });
      if (!text.trim()) return show({ running: false, error: ta("errors.empty") });
      show({ running: false });
      // Kept with the thread, as the next read of it brings it.
      const now = latest.current;
      if (now && ended.stopReason === "stop") {
        const next = { ...now, summary: { text: text.trim(), messageId: newest.id } };
        keepThread(mailboxId, folderId, next);
        setThread(next);
      }
    } catch {
      if (!controller.signal.aborted) show({ running: false, error: ta("errors.provider") });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }, [mailboxId, folderId, threadId, locale, setThread, t, ta]);

  const state: Summary | null = asked ?? (thread?.summary ? { ...thread.summary, running: false, error: null } : null);
  return { state, run: () => void run() };
}

function SummaryCard({ state, thread, onAgain }: { state: Summary; thread: MailThreadView; onAgain: () => void }) {
  const t = useTranslations("mail");
  const at = thread.messages.findIndex((m) => m.id === state.messageId);
  const newer = at >= 0 ? thread.messages.length - 1 - at : 0;
  return (
    <section aria-label={t("ai.summary")} className="mx-6 mt-4 rounded-md border border-border px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">{t("ai.summary")}</span>
        {state.running ? (
          <span aria-live="polite">{t("ai.summarizing")}</span>
        ) : (
          <IconButton label={t("ai.resummarize")} className="-my-1 h-7 w-7 text-fg-icon" onClick={onAgain}>
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {state.error ? (
        <p role="alert" className="mt-1.5 text-danger">
          {state.error}
        </p>
      ) : state.text ? (
        <p className="mt-1.5 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" aria-busy={state.running}>
          {state.text.trim()}
        </p>
      ) : (
        <div className="mt-2 space-y-2" aria-busy>
          {[85, 60].map((w) => (
            <div key={w} className="h-3 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {!state.running && newer > 0 && (
        <p className="mt-1.5 text-xs text-fg-muted">
          {t("ai.newer", { count: newer })}{" "}
          <button type="button" className="font-medium text-accent hover:underline" onClick={onAgain}>
            {t("ai.resummarize")}
          </button>
        </p>
      )}
    </section>
  );
}

/** The thread open beside the list: its messages, the row its other party is, and answering. */
export function ThreadView({
  workspaceId,
  ai,
  box,
  folder,
  threadId,
  first,
  starred,
  onAction,
  onBack,
  onRead,
  compose,
  onComposeChange,
  onSent,
}: {
  workspaceId: string;
  /** The workspace has AI on: a summary and the composer's writer are offered. */
  ai: boolean;
  box: MailboxTabView;
  folder: MailFolderView;
  threadId: string;
  /** The message the list shows for the thread, read at once beside the thread itself. */
  first: { id: string; unread: boolean } | null;
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
  // What this tab read of the thread before shows at once; it is read again behind it.
  const [thread, setThread] = useState<MailThreadView | null>(() => cachedThread(box.id, folder.id, threadId));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => (thread ? opensFirst(thread) : new Set()));
  const [bodies, setBodies] = useState<Record<string, Loaded>>(() => {
    const shown: Record<string, Loaded> = {};
    for (const id of thread ? opensFirst(thread) : first ? [first.id] : []) {
      const body = cachedBody(id, false);
      if (body) shown[id] = { body, error: null, loading: false };
    }
    return shown;
  });
  const [version, setVersion] = useState(0);
  const [answering, setAnswering] = useState<string | null>(null);
  const [aiStart, setAiStart] = useState<MailWriteAction | null>(null);
  // Closing the composer forgets which message it answered, so R, A and F answer the newest again.
  if (!compose && answering) setAnswering(null);
  if (!compose && aiStart) setAiStart(null);
  const summary = useSummary(box.id, folder.id, threadId, thread, setThread);
  // Messages asked for already: the list's message is asked for before the thread comes.
  const asked = useRef(new Set<string>());

  /** Reads a message's body; with `images`, its images from other sites, remembered for the next time. */
  const loadBody = useCallback(
    (id: string, seen: boolean, images = false) => {
      asked.current.add(id);
      const held = cachedBody(id, images);
      // Shown from this tab's memory; asked again only to mark it read.
      if (held) {
        setBodies((b) => ({ ...b, [id]: { body: held, error: null, loading: false } }));
        if (!seen) void read("mailBody", { id, images }).then((result) => result.ok && onRead()).catch(() => {});
        return;
      }
      setBodies((b) => ({ ...b, [id]: { body: b[id]?.body ?? null, error: null, loading: true } }));
      void read("mailBody", { id, images })
        .then((result) => {
          if (result.ok) keepBody(id, result.data);
          setBodies((b) => ({ ...b, [id]: result.ok ? { body: result.data, error: null, loading: false } : { body: null, error: result.error, loading: false } }));
          if (result.ok && !seen) onRead();
        })
        .catch(() => setBodies((b) => ({ ...b, [id]: { body: null, error: t("loadFailed"), loading: false } })));
    },
    [onRead, t],
  );

  /** Always shows images from a sender, or stops, and reads again the sender's messages on screen. */
  const trustSender = (address: string, trust: boolean) => {
    void (trust ? trustImageSenderAction : forgetImageSenderAction)({ mailboxId: box.id, address })
      .then((result) => {
        if (!result.ok) return;
        forgetBodies();
        for (const m of thread?.messages ?? []) if (m.from.address === address && bodies[m.id]?.body) loadBody(m.id, true);
      })
      .catch(() => {});
  };

  useEffect(() => {
    let live = true;
    setError(null);
    if (first && !asked.current.has(first.id)) loadBody(first.id, !first.unread);
    void read("mailThread", { mailboxId: box.id, threadId, folderId: folder.id })
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        keepThread(box.id, folder.id, result.data);
        setThread(result.data);
        const opened = opensFirst(result.data);
        setOpen((was) => new Set([...was, ...opened]));
        for (const m of result.data.messages) if (opened.has(m.id) && !asked.current.has(m.id)) loadBody(m.id, m.seen);
      })
      .catch(() => live && setError(t("loadFailed")));
    return () => {
      live = false;
    };
    // loadBody changes with onRead, first with the list; the thread is read again only when it is another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.id, threadId, folder.id, version]);

  const toggle = (message: MailMessageView) => {
    const next = new Set(open);
    if (next.has(message.id)) next.delete(message.id);
    else {
      next.add(message.id);
      if (!bodies[message.id]?.body) loadBody(message.id, message.seen);
    }
    setOpen(next);
  };

  const last = thread?.messages[thread.messages.length - 1] ?? null;
  // The message a reply or forward answers: the one whose button was pressed, else (keys) the newest.
  const source = thread?.messages.find((m) => m.id === answering) ?? last;
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
        {/* Up here rather than under the subject, where a line of its own pushes the mail down. */}
        {thread && <span className="ms-auto shrink-0 pe-3 text-sm text-fg-muted">{t("messages", { count: thread.messages.length })}</span>}
        {/* A summary shown has its own button to write it again. */}
        {ai && thread && !summary.state && (
          <Button onClick={summary.run} title={t("ai.summarizeHint")} className="h-8 shrink-0">
            <Sparkles className="h-4 w-4 text-fg-icon" />
            {t("ai.summarize")}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {error ? (
          <p className="px-6 pt-6 text-sm text-fg-muted">{error}</p>
        ) : !thread ? (
          <div className="px-6 pt-5" aria-busy>
            <div className="h-7 w-2/3 animate-pulse rounded bg-bg-hover" />
          </div>
        ) : (
          <>
            <div className="px-6 pt-5">
              <h2 className="text-xl leading-snug font-semibold [overflow-wrap:anywhere]">{thread.subject || t("noSubject")}</h2>
            </div>
            {summary.state && <SummaryCard state={summary.state} thread={thread} onAgain={summary.run} />}
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
                  onImages={() => loadBody(m.id, true, true)}
                  onTrust={(trust) => trustSender(m.from.address, trust)}
                  last={m.id === last?.id}
                  ai={ai}
                  onCompose={(mode, start) => {
                    setAnswering(m.id);
                    setAiStart(start ?? null);
                    onComposeChange(mode);
                  }}
                />
              ))}
            </div>
            {compose && source && (
              <div className="px-6 pt-2">
                <Composer
                  key={`${compose}-${source.id}-${aiStart ?? ""}`}
                  workspaceId={workspaceId}
                  ai={ai}
                  aiStart={aiStart}
                  box={box}
                  mode={compose}
                  layout="inline"
                  source={{ message: source, body: bodies[source.id]?.body ?? null }}
                  onClose={() => onComposeChange(null)}
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
