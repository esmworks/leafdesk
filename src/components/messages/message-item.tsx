"use client";

import { Bookmark, BookmarkCheck, CircleCheck, Copy, Download, FileText, Forward, History, Link2, MailOpen, MessageSquareText, MoreHorizontal, Pencil, Pin, PinOff, SmilePlus, Trash2, Webhook } from "lucide-react";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { plainClick, useFileViewer } from "@/components/file-viewer";
import { lazyPart } from "@/components/lazy-part";
import { showToast } from "@/components/toast";
import { cn, MenuItem, MenuSeparator, Popover, textareaClass } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import type { FileView, MessageView } from "@/lib/message-wire";
import { messagesPath, type SystemEvent } from "@/lib/messages";
import { EmojiPicker, QUICK_REACTIONS, rememberEmoji } from "./emoji-picker";
import { MessageBody } from "./message-body";
import { PersonFace } from "./person";
import { call, channelTitle, dropPending, patchMessage, personName, retrySend, useView, type Pending, type View } from "./store";

/** Link cards load with the first message that has them: their bookmark card brings the embed rules along. */
const LinkCards = lazyPart(() => import("./link-cards").then((m) => m.LinkCards));

/** What a message row may do in the place it shows (a channel's list, a thread, a result list). */
export type ItemContext = {
  workspaceId: string;
  /** Opens the message's thread beside the list. */
  openThread?: (threadId: string) => void;
  /** Asks to forward the message (a dialog of the page). */
  forward?: (messageId: string) => void;
  /** The person may delete others' messages here (a channel's admin, a workspace owner). */
  moderates: boolean;
  /** Writing is possible here (a member, the channel not archived). */
  writes: boolean;
  /** In a thread's panel: no thread summary, replies are what it lists. */
  inThread?: boolean;
};

const time = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

/** A pending send drawn as a message. */
export function pendingView(p: Pending, me: string): MessageView {
  return {
    id: p.id,
    channelId: p.channelId,
    seq: Number.MAX_SAFE_INTEGER,
    threadId: p.threadId,
    authorId: me,
    kind: "message",
    body: p.body,
    data: null,
    alsoInChannel: p.alsoInChannel,
    replyCount: 0,
    lastReplySeq: 0,
    lastReplyAt: null,
    repliers: [],
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinnedBy: null,
    createdAt: p.createdAt,
    reactions: [],
    files: [],
    rev: 0,
  };
}

function SystemLine({ m, s }: { m: MessageView; s: View }) {
  const t = useTranslations("messages.system");
  const someone = useTranslations("messages")("someone");
  const event = m.data?.system as SystemEvent | undefined;
  const who = personName(s, m.authorId, someone);
  const names = (ids: string[]) => ids.map((id) => personName(s, id, someone)).join(", ");
  if (!event) return null;
  const text =
    event.event === "added" ? t("added", { actor: who, people: names(event.users) })
    : event.event === "removed" ? t("removed", { actor: who, people: names(event.users) })
    : event.event === "renamed" ? t("renamed", { actor: who, from: event.from, to: event.to })
    : event.event === "topic" ? t("topic", { actor: who, to: event.to })
    : event.event === "description" ? t("description", { actor: who })
    : event.event === "private" ? t("private", { actor: who })
    : t(event.event, { actor: who });
  return <p className="py-1 ps-12 text-[13px] text-fg-muted">{text}</p>;
}

/** Videos play where they were posted; PDF, Office files, tables and text show in the file viewer. */
const VIDEO_TYPES = /^video\/(mp4|webm|ogg|quicktime)$/;

function Files({ files }: { files: FileView[] }) {
  const t = useTranslations("messages");
  const viewer = useFileViewer();
  const images = files.filter((f) => f.contentType.startsWith("image/") && f.contentType !== "image/svg+xml");
  const videos = files.filter((f) => VIDEO_TYPES.test(f.contentType));
  const others = files.filter((f) => !images.includes(f) && !videos.includes(f));
  // Opened over the conversation, never in a tab of its own: an app on a phone's home screen has no
  // way back from one. A click with a modifier still opens the file in a tab.
  const openAt = (event: MouseEvent, file: FileView) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    const shown = files.filter((f) => !videos.includes(f));
    viewer.open(
      shown.map((f) => ({ url: f.url, name: f.name, type: f.contentType })),
      shown.indexOf(file),
    );
  };
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((f) => {
            // The size read before upload keeps the message's room while it loads.
            const w = f.width && f.height ? Math.min(360, f.width) : 360;
            const h = f.width && f.height ? Math.round((w / f.width) * f.height) : undefined;
            return (
              <a key={f.id} href={f.url} target="_blank" rel="noopener" onClick={(e) => openAt(e, f)} className="block overflow-hidden rounded-lg border border-border bg-bg-subtle">
                <img src={f.url} alt={f.name} loading="lazy" decoding="async" width={w} height={h} style={{ maxHeight: 360, width: w, height: h ? Math.min(h, 360) : undefined }} className="object-cover" />
              </a>
            );
          })}
        </div>
      )}
      {videos.map((f) => (
        <video
          key={f.id}
          src={f.url}
          controls
          playsInline
          preload="metadata"
          aria-label={f.name}
          width={f.width ? Math.min(480, f.width) : 480}
          className="max-h-[360px] max-w-full rounded-lg border border-border bg-black"
        />
      ))}
      {others.map((f) => (
        <span key={f.id} className="flex w-fit max-w-full items-center rounded-lg border border-border">
          <a href={f.url} target="_blank" rel="noopener" onClick={(e) => openAt(e, f)} className="flex min-w-0 items-center gap-2 rounded-s-lg py-2 ps-3 pe-2 hover:bg-bg-hover">
            <FileText className="h-5 w-5 shrink-0 text-fg-icon" />
            <span className="min-w-0">
              <span className="block truncate text-sm text-fg">{f.name}</span>
              <span className="block text-xs text-fg-faint tabular-nums">{formatBytes(f.size)}</span>
            </span>
          </a>
          <a href={`${f.url}?download=1`} download={f.name} aria-label={t("download")} title={t("download")} className="self-stretch rounded-e-lg px-2.5 text-fg-muted hover:bg-bg-hover hover:text-fg flex items-center">
            <Download className="h-4 w-4 shrink-0" />
          </a>
        </span>
      ))}
      {viewer.element}
    </div>
  );
}

function Reactions({ m, s, writes }: { m: MessageView; s: View; writes: boolean }) {
  const t = useTranslations("messages");
  const [pickerAt, setPickerAt] = useState<Element | null>(null);
  if (!m.reactions.length) return null;
  const toggle = (emoji: string, on: boolean) => {
    // Shown at once; the server's change follows.
    const reactions = m.reactions
      .map((r) => (r.emoji === emoji ? { ...r, userIds: on ? [...r.userIds, s.me] : r.userIds.filter((id) => id !== s.me) } : r))
      .filter((r) => r.userIds.length);
    if (on && !reactions.some((r) => r.emoji === emoji)) reactions.push({ emoji, userIds: [s.me] });
    patchMessage(m.id, { reactions });
    if (on) rememberEmoji(emoji);
    void call("react", { messageId: m.id, emoji, on }).catch(() => showToast({ message: t("errors.internal") }));
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {m.reactions.map((r) => {
        const mine = r.userIds.includes(s.me);
        const names = r.userIds.map((id) => personName(s, id, t("someone"))).join(", ");
        return (
          <button
            key={r.emoji}
            type="button"
            disabled={!writes}
            onClick={() => toggle(r.emoji, !mine)}
            title={t("reactedBy", { people: names, emoji: r.emoji })}
            aria-label={t("reactedBy", { people: names, emoji: r.emoji })}
            aria-pressed={mine}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs tabular-nums",
              mine ? "border-accent bg-accent/10 text-fg" : "border-border text-fg-muted hover:border-fg-faint",
            )}
          >
            <span className="text-sm leading-none">{r.emoji}</span>
            {r.userIds.length}
          </button>
        );
      })}
      {writes && (
        <Popover
          at={pickerAt}
          trigger={({ toggle: open }) => (
            <button type="button" onClick={(e) => opened(e, setPickerAt, open)} aria-label={t("addReaction")} className="flex h-6 w-7 items-center justify-center rounded-md border border-transparent text-fg-muted hover:border-border hover:text-fg">
              <SmilePlus className="h-3.5 w-3.5" />
            </button>
          )}
        >
          {(close) => (
            <EmojiPicker
              onPick={(emoji) => {
                close();
                if (!m.reactions.some((r) => r.emoji === emoji && r.userIds.includes(s.me))) toggle(emoji, true);
              }}
            />
          )}
        </Popover>
      )}
    </div>
  );
}

function ThreadSummary({ m, s, open }: { m: MessageView; s: View; open: () => void }) {
  const t = useTranslations("messages");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const thread = s.threads.get(m.id);
  const unread = !!thread && m.lastReplySeq > thread.lastReadSeq;
  return (
    <button type="button" onClick={open} className="group/thread mt-1 flex w-fit max-w-full items-center gap-2 rounded-md py-0.5 pe-2 ps-0.5 text-xs hover:bg-bg-hover">
      <span className="flex -space-x-1">
        {m.repliers.slice(0, 4).map((id) => (
          <PersonFace key={id} s={s} userId={id} size="xs" presence={false} />
        ))}
      </span>
      <span className={cn("shrink-0 whitespace-nowrap font-medium text-accent", unread && "font-semibold")}>{t("replies", { count: m.replyCount })}</span>
      {m.lastReplyAt && <span className="min-w-0 truncate text-fg-faint">{t("lastReply", { when: format.relativeTime(new Date(m.lastReplyAt), now) })}</span>}
    </button>
  );
}

function Forwarded({ m, s, workspaceId }: { m: MessageView; s: View; workspaceId: string }) {
  const t = useTranslations("messages");
  const f = m.data?.forward;
  if (!f) return null;
  const channel = s.channels.get(f.channelId);
  const where = channel ? channelTitle(s, channel, { you: t("you"), someone: t("someone") }) : null;
  const href = channel ? messagesPath(workspaceId, { channelId: f.channelId, messageId: f.messageId }) : null;
  return (
    <div className="mt-1 border-s-2 border-border ps-3">
      <p className="flex items-center gap-1 text-xs text-fg-muted">
        <Forward className="h-3 w-3" />
        {t("forwardedFrom", { person: personName(s, f.authorId, t("someone")) })}
        {where && href && (
          <a href={href} className="hover:underline">
            · {channel?.kind === "direct" ? where : `#${where}`}
          </a>
        )}
      </p>
      <MessageBody body={f.body} workspaceId={workspaceId} />
    </div>
  );
}

function Editor({ m, done }: { m: MessageView; done: () => void }) {
  const t = useTranslations("messages");
  const [text, setText] = useState(m.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => {
    const body = text.trimEnd();
    if (body === m.body) return done();
    patchMessage(m.id, { body, editedAt: new Date().toISOString() });
    done();
    void call("edit", { messageId: m.id, body }).catch(() => {
      patchMessage(m.id, { body: m.body, editedAt: m.editedAt });
      showToast({ message: t("errors.internal") });
    });
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
        rows={Math.min(10, text.split("\n").length + 1)}
        className={cn(textareaClass, "w-full resize-none")}
      />
      <p className="mt-1 text-xs text-fg-faint">{t("editHint")}</p>
    </div>
  );
}

/**
 * Opens a row's menu from its button, fixed to the window (`Popover`'s `at`): one placed inside the
 * scrolling list would lengthen it, and the list, held to its bottom, would jump up under it.
 */
function opened(e: { currentTarget: Element }, setAt: (at: Element) => void, toggle: () => void) {
  setAt(e.currentTarget);
  toggle();
}

function VersionsDialogButton({ m }: { m: MessageView }) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const [versions, setVersions] = useState<{ body: string; replacedAt: string }[] | null>(null);
  return (
    <Popover
      align="end"
      at={null}
      trigger={({ toggle }) => (
        <MenuItem
          icon={<History className="h-4 w-4" />}
          onClick={() => {
            toggle();
            void call<{ body: string; replacedAt: string }[]>("versions", { messageId: m.id }).then(setVersions, () => setVersions([]));
          }}
        >
          {t("actions.history")}
        </MenuItem>
      )}
      className="w-80"
    >
      <div className="max-h-72 overflow-y-auto p-1">
        {versions === null ? (
          <p className="text-xs text-fg-faint">{t("loading")}</p>
        ) : (
          versions.map((v, i) => (
            <div key={i} className="border-b border-border/60 py-1.5 last:border-0">
              <p className="text-xs text-fg-faint">{new Date(v.replacedAt).toLocaleString(locale)}</p>
              <p className="text-sm whitespace-pre-wrap text-fg-muted">{v.body}</p>
            </div>
          ))
        )}
      </div>
    </Popover>
  );
}

function Toolbar({ m, s, ctx, onEdit }: { m: MessageView; s: View; ctx: ItemContext; onEdit: () => void }) {
  const t = useTranslations("messages");
  const own = m.authorId === s.me;
  const saved = s.saved.get(m.id);
  const react = (emoji: string) => {
    const has = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(s.me);
    const reactions = has ? m.reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: r.userIds.filter((id) => id !== s.me) } : r)).filter((r) => r.userIds.length) : m.reactions.some((r) => r.emoji === emoji) ? m.reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, s.me] } : r)) : [...m.reactions, { emoji, userIds: [s.me] }];
    patchMessage(m.id, { reactions });
    rememberEmoji(emoji);
    void call("react", { messageId: m.id, emoji, on: !has }).catch(() => {});
  };
  const copyLink = () => {
    const url = new URL(messagesPath(ctx.workspaceId, { channelId: m.channelId, messageId: m.id, threadId: m.threadId }), window.location.href).toString();
    void navigator.clipboard.writeText(url).then(() => showToast({ message: t("linkCopied") }));
  };
  const [pickerAt, setPickerAt] = useState<Element | null>(null);
  const [moreAt, setMoreAt] = useState<Element | null>(null);
  const button = "flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg";
  return (
    <div className="absolute -top-4 end-3 z-10 hidden items-center rounded-lg border border-border bg-bg p-0.5 shadow-sm group-hover/message:flex group-focus-within/message:flex has-[[data-open]]:flex">
      {ctx.writes &&
        QUICK_REACTIONS.slice(0, 3).map((e) => (
          <button key={e} type="button" onClick={() => react(e)} aria-label={t("reactWith", { emoji: e })} className={cn(button, "text-base")}>
            {e}
          </button>
        ))}
      {ctx.writes && (
        <Popover
          align="end"
          at={pickerAt}
          trigger={({ toggle }) => (
            <button type="button" onClick={(e) => opened(e, setPickerAt, toggle)} aria-label={t("addReaction")} title={t("addReaction")} className={button}>
              <SmilePlus className="h-4 w-4" />
            </button>
          )}
        >
          {(close) => (
            <EmojiPicker
              onPick={(e) => {
                close();
                react(e);
              }}
            />
          )}
        </Popover>
      )}
      {ctx.openThread && !m.threadId && !ctx.inThread && (
        <button type="button" onClick={() => ctx.openThread!(m.id)} aria-label={t("actions.reply")} title={t("actions.reply")} className={button}>
          <MessageSquareText className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        onClick={() => void call("save", { messageId: m.id, saved: !saved || !!saved.doneAt }).catch(() => {})}
        aria-label={saved && !saved.doneAt ? t("actions.unsave") : t("actions.save")}
        title={saved && !saved.doneAt ? t("actions.unsave") : t("actions.save")}
        className={button}
      >
        {saved && !saved.doneAt ? <BookmarkCheck className="h-4 w-4 text-accent" /> : <Bookmark className="h-4 w-4" />}
      </button>
      <Popover
        align="end"
        at={moreAt}
        trigger={({ toggle }) => (
          <button type="button" onClick={(e) => opened(e, setMoreAt, toggle)} aria-label={t("actions.more")} title={t("actions.more")} className={button}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      >
        {(close) => (
          <>
            {own && ctx.writes && m.kind === "message" && (
              <MenuItem
                icon={<Pencil className="h-4 w-4" />}
                onClick={() => {
                  close();
                  onEdit();
                }}
                trailing={<kbd className="font-sans text-xs text-fg-faint">E</kbd>}
              >
                {t("actions.edit")}
              </MenuItem>
            )}
            <MenuItem
              icon={<MailOpen className="h-4 w-4" />}
              onClick={() => {
                close();
                void call("unread", { channelId: m.channelId, seq: m.seq }).catch(() => {});
              }}
            >
              {t("actions.markUnread")}
            </MenuItem>
            <MenuItem
              icon={<Link2 className="h-4 w-4" />}
              onClick={() => {
                close();
                copyLink();
              }}
            >
              {t("actions.copyLink")}
            </MenuItem>
            <MenuItem
              icon={<Copy className="h-4 w-4" />}
              onClick={() => {
                close();
                void navigator.clipboard.writeText(m.body);
              }}
            >
              {t("actions.copyText")}
            </MenuItem>
            {ctx.forward && (
              <MenuItem
                icon={<Forward className="h-4 w-4" />}
                onClick={() => {
                  close();
                  ctx.forward!(m.id);
                }}
              >
                {t("actions.forward")}
              </MenuItem>
            )}
            {m.kind === "message" && !m.deletedAt && (
              <MenuItem
                icon={<CircleCheck className="h-4 w-4" />}
                onClick={() => {
                  close();
                  void call<{ rowId: string }>("task", { messageId: m.id }).then(
                    ({ rowId }) => showToast({ message: t("taskAdded"), action: { label: t("open"), run: () => void window.location.assign(`/w/${ctx.workspaceId}/p/${rowId}`) } }),
                    () => showToast({ message: t("taskFailed") }),
                  );
                }}
              >
                {t("actions.task")}
              </MenuItem>
            )}
            {ctx.writes && (
              <MenuItem
                icon={m.pinnedAt ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                onClick={() => {
                  close();
                  void call("pin", { messageId: m.id, on: !m.pinnedAt }).catch(() => {});
                }}
              >
                {m.pinnedAt ? t("actions.unpin") : t("actions.pin")}
              </MenuItem>
            )}
            {[
              ["remind20", 20 * 60_000],
              ["remind60", 60 * 60_000],
              ["remindTomorrow", 0],
            ].map(([key, ms]) => (
              <MenuItem
                key={key as string}
                icon={<Bookmark className="h-4 w-4" />}
                onClick={() => {
                  close();
                  const at = ms ? new Date(Date.now() + (ms as number)) : tomorrowMorning();
                  void call("save", { messageId: m.id, saved: true, remindAt: at.toISOString() }).then(() => showToast({ message: t("reminderSet") }), () => {});
                }}
              >
                {t(`actions.${key as "remind20"}`)}
              </MenuItem>
            ))}
            {m.editedAt && <VersionsDialogButton m={m} />}
            {(own || ctx.moderates) && (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    if (!window.confirm(t("deleteConfirm"))) return;
                    void call("delete", { messageId: m.id }).catch((e) => showToast({ message: t(`errors.${(e as { code?: string }).code === "held" ? "held" : "internal"}`) }));
                  }}
                >
                  {t("actions.delete")}
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>
    </div>
  );
}

function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/**
 * One message: who wrote it and when (left out when it follows the same person's within a few
 * minutes), its words, files, the message it forwards, reactions and its thread's summary, with
 * its actions on hover. A message being sent shows dimmed; one that failed offers to try again.
 */
export const MessageItem = memo(function MessageItem({
  m,
  continued,
  ctx,
  highlighted,
  pending,
  editing,
  setEditing,
}: {
  m: MessageView;
  continued: boolean;
  ctx: ItemContext;
  highlighted?: boolean;
  pending?: Pending;
  editing?: boolean;
  setEditing?: (id: string | null) => void;
}) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const s = useView();
  if (m.kind === "system") return <SystemLine m={m} s={s} />;
  const author = s.people.get(m.authorId ?? "");
  const hook = m.data?.webhook;
  const name = hook?.name ?? m.data?.importedFrom?.name ?? personName(s, m.authorId, t("someone"));
  const status = m.authorId ? s.statuses.get(m.authorId) : undefined;
  const statusShown = status && (status.emoji || status.text) && (!status.statusUntil || new Date(status.statusUntil) > new Date()) ? status : null;
  const when = new Date(m.createdAt);
  const deleted = !!m.deletedAt;
  return (
    <div
      id={`message-${m.id}`}
      data-message-id={m.id}
      data-seq={m.seq}
      className={cn(
        "group/message relative flex gap-3 px-4 hover:bg-bg-hover/60",
        continued ? "py-0.5" : "pt-2 pb-0.5",
        highlighted && "bg-accent/10 hover:bg-accent/10",
        m.pinnedAt && !highlighted && "bg-bg-subtle/60",
        pending && "opacity-60",
      )}
    >
      <div className="w-9 shrink-0">
        {continued ? (
          <time dateTime={m.createdAt} title={when.toLocaleString(locale)} className="invisible block pt-0.5 text-end text-[10px] leading-5 text-fg-faint tabular-nums group-hover/message:visible">
            {time(m.createdAt, locale)}
          </time>
        ) : (
          (m.authorId && <PersonFace s={s} userId={m.authorId} size="lg" presence={false} />) ||
          (hook && (
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-active text-fg-muted">
              <Webhook className="h-4 w-4" />
            </span>
          ))
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-fg">{name}</span>
            {author?.agent && <span className="rounded bg-bg-active px-1 text-[10px] font-medium text-fg-muted uppercase">{t("agent")}</span>}
            {hook && <span className="rounded bg-bg-active px-1 text-[10px] font-medium text-fg-muted uppercase">{t("webhook")}</span>}
            {m.data?.automation && <span className="truncate text-xs text-fg-faint">{t("viaAutomation", { name: m.data.automation.name })}</span>}
            {statusShown && (
              <span className="truncate text-xs text-fg-muted" title={statusShown.text}>
                {statusShown.emoji} {statusShown.text}
              </span>
            )}
            <time dateTime={m.createdAt} title={when.toLocaleString(locale)} className="shrink-0 text-xs text-fg-faint tabular-nums">
              {time(m.createdAt, locale)}
            </time>
            {m.pinnedAt && (
              <span className="flex items-center gap-0.5 text-xs text-fg-faint">
                <Pin className="h-3 w-3" />
                {t("pinned")}
              </span>
            )}
          </div>
        )}
        {deleted ? (
          <p className="text-sm text-fg-faint italic">{t("deleted")}</p>
        ) : editing && setEditing ? (
          <Editor m={m} done={() => setEditing(null)} />
        ) : (
          <>
            {m.body && <MessageBody body={m.body} workspaceId={ctx.workspaceId} edited={m.editedAt ? new Date(m.editedAt).toLocaleString(locale) : null} />}
            <Forwarded m={m} s={s} workspaceId={ctx.workspaceId} />
            {m.files.length > 0 && <Files files={m.files} />}
            {m.data?.previews?.length ? <LinkCards messageId={m.id} previews={m.data.previews} own={m.authorId === s.me} /> : null}
          </>
        )}
        {m.threadId && m.alsoInChannel && !ctx.inThread && ctx.openThread && (
          <button type="button" onClick={() => ctx.openThread!(m.threadId!)} className="text-xs text-fg-muted hover:underline">
            {t("repliedInThread")}
          </button>
        )}
        {!deleted && <Reactions m={m} s={s} writes={ctx.writes && !pending} />}
        {!m.threadId && m.replyCount > 0 && !ctx.inThread && ctx.openThread && <ThreadSummary m={m} s={s} open={() => ctx.openThread!(m.id)} />}
        {pending &&
          (pending.failed ? (
            <p className="mt-0.5 flex items-center gap-2 text-xs text-danger">
              {t("sendFailed")}
              <button type="button" onClick={() => void retrySend(pending.id)?.catch(() => {})} className="font-medium underline">
                {t("retry")}
              </button>
              <button type="button" onClick={() => dropPending(pending.id)} className="text-fg-muted underline">
                {t("discard")}
              </button>
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-fg-faint">{t("sending")}</p>
          ))}
      </div>
      {!pending && !deleted && !editing && <Toolbar m={m} s={s} ctx={ctx} onEdit={() => setEditing?.(m.id)} />}
    </div>
  );
});
