"use client";

import { AtSign, Bookmark, Check, Clock, Hash, Loader2, Lock, MessagesSquare, Search, SendHorizontal, Trash2, Undo2 } from "lucide-react";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/components/toast";
import { cn, Input } from "@/components/ui";
import type { ChannelView, MessageView } from "@/lib/message-wire";
import { messagesPath, type MessagesView } from "@/lib/messages";
import { parseMessageSearch, searchAsks, SEARCH_HAS } from "@/lib/message-search-query";
import { MessageBody } from "./message-body";
import { MessageItem, type ItemContext } from "./message-item";
import { unreadThread } from "./messages-sidebar";
import { PersonFace } from "./person";
import { call, channelTitle, loadMessages, messagesState, putMessages, useMessages, useView } from "./store";

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

function go(href: string) {
  window.history.pushState(null, "", href);
}

/** Where a message is, above it in a list of results: its channel and when. */
function Where({ c, m, workspaceId, onOpen }: { c: ChannelView | undefined; m: MessageView; workspaceId: string; onOpen: () => void }) {
  const t = useTranslations("messages");
  const view = useView();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  return (
    <div className="flex items-center gap-1.5 px-4 pt-2 text-xs text-fg-muted">
      {c?.kind === "private" ? <Lock className="h-3 w-3" /> : c?.kind === "direct" ? <AtSign className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
      <a
        href={messagesPath(workspaceId, { channelId: m.channelId, messageId: m.id })}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onOpen();
        }}
        className="font-medium text-fg hover:underline"
      >
        {c ? channelTitle(view, c, { you: t("you"), someone: t("someone") }) : t("someChannel")}
      </a>
      <span>·</span>
      <time dateTime={m.createdAt}>{format.relativeTime(new Date(m.createdAt), now)}</time>
    </div>
  );
}

function openMessage(workspaceId: string, m: MessageView) {
  if (m.threadId && !m.alsoInChannel) go(messagesPath(workspaceId, { channelId: m.channelId, threadId: m.threadId, messageId: m.id }));
  else go(messagesPath(workspaceId, { channelId: m.channelId, messageId: m.id }));
}

function useResultContext(workspaceId: string, forward: (id: string) => void, owner: boolean): ItemContext {
  return useMemo(
    () => ({
      workspaceId,
      forward,
      moderates: owner,
      writes: true,
      openThread: (threadId: string) => {
        const m = messagesState().messages.get(threadId);
        if (m) go(messagesPath(workspaceId, { channelId: m.channelId, threadId }));
      },
    }),
    [workspaceId, forward, owner],
  );
}

function Results({ list, workspaceId, ctx, empty }: { list: MessageView[]; workspaceId: string; ctx: ItemContext; empty: string }) {
  const view = useView();
  if (!list.length) return <p className="px-4 py-12 text-center text-sm text-fg-muted">{empty}</p>;
  return (
    <ul>
      {list.map((m) => (
        <li key={m.id} className="border-b border-border/60 pb-1 last:border-0">
          <Where c={view.channels.get(m.channelId)} m={m} workspaceId={workspaceId} onOpen={() => openMessage(workspaceId, m)} />
          <MessageItem m={m} continued={false} ctx={ctx} />
        </li>
      ))}
    </ul>
  );
}

function ViewHead({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[860px] items-center gap-2 px-4 pt-6 pb-3">
      <span className="text-fg-icon [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-fg">{title}</h1>
      {children}
    </div>
  );
}

/** Threads the person follows, those with new replies first. */
function ThreadsView({ workspaceId, ctx }: { workspaceId: string; ctx: ItemContext }) {
  const t = useTranslations("messages");
  const threads = useMessages((s) => s.threads);
  const messages = useMessages((s) => s.messages);
  const [loading, setLoading] = useState(true);
  const followed = useMemo(() => [...threads.values()].filter((x) => x.following).sort((a, b) => (b.lastReplyAt ?? "").localeCompare(a.lastReplyAt ?? "")), [threads]);
  useEffect(() => {
    void loadMessages(followed.map((x) => x.threadId).slice(0, 100)).finally(() => setLoading(false));
  }, [followed]);
  const s = useMessages((x) => x);
  const list = followed.flatMap((x) => (messages.get(x.threadId) ? [messages.get(x.threadId)!] : []));
  const unread = list.filter((m) => unreadThread(s, m.id));
  const read = list.filter((m) => !unreadThread(s, m.id));
  if (loading && !list.length) return <Spinner />;
  return (
    <>
      <ViewHead icon={<MessagesSquare />} title={t("views.threads")}>
        {unread.length > 0 && (
          <button
            type="button"
            onClick={() => unread.forEach((m) => void call("readThread", { threadId: m.id, seq: m.lastReplySeq }).catch(() => {}))}
            className="text-xs text-accent hover:underline"
          >
            {t("markAllRead")}
          </button>
        )}
      </ViewHead>
      <div className="mx-auto w-full max-w-[860px]">
        {!list.length ? (
          <p className="px-4 py-12 text-center text-sm text-fg-muted">{t("noThreads")}</p>
        ) : (
          <ul>
            {[...unread, ...read].map((m) => {
              const isNew = unreadThread(s, m.id);
              return (
                <li key={m.id} className={cn("border-b border-border/60 pb-1 last:border-0", isNew && "bg-accent/5")}>
                  <Where c={s.channels.get(m.channelId)} m={m} workspaceId={workspaceId} onOpen={() => go(messagesPath(workspaceId, { channelId: m.channelId, threadId: m.id }))} />
                  <MessageItem m={m} continued={false} ctx={ctx} />
                  {isNew && <p className="px-4 pb-1 ps-16 text-xs font-medium text-accent">{t("newReplies")}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

type Reaction = { messageId: string; userId: string; emoji: string; createdAt: string };

/** Mentions of the person and reactions to their messages, newest first. */
function ActivityView({ workspaceId, ctx }: { workspaceId: string; ctx: ItemContext }) {
  const t = useTranslations("messages");
  const view = useView();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [mentions, setMentions] = useState<MessageView[] | null>(null);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [what, setWhat] = useState<"all" | "mentions" | "reactions">("all");
  const messages = useMessages((s) => s.messages);
  useEffect(() => {
    void call<MessageView[]>("mentions", {}).then(
      (list) => {
        putMessages(list);
        setMentions(list);
      },
      () => setMentions([]),
    );
    void call<Reaction[]>("reactions").then(
      (list) => {
        setReactions(list);
        void loadMessages([...new Set(list.map((r) => r.messageId))]);
      },
      () => {},
    );
  }, []);
  if (!mentions) return <Spinner />;
  type Item = { key: string; at: string; m: MessageView; reaction?: Reaction[] };
  const items: Item[] = [];
  if (what !== "reactions") for (const m of mentions) items.push({ key: `m:${m.id}`, at: m.createdAt, m: messages.get(m.id) ?? m });
  if (what !== "mentions") {
    // Reactions to one message, close in time, as one item.
    const byMessage = new Map<string, Reaction[]>();
    for (const r of reactions) byMessage.set(r.messageId, [...(byMessage.get(r.messageId) ?? []), r]);
    for (const [id, list] of byMessage) {
      const m = messages.get(id);
      if (m) items.push({ key: `r:${id}`, at: list[0].createdAt, m, reaction: list });
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <ViewHead icon={<AtSign />} title={t("views.activity")}>
        <Segmented value={what} onChange={setWhat} options={[["all", t("activityAll")], ["mentions", t("activityMentions")], ["reactions", t("activityReactions")]]} />
      </ViewHead>
      <div className="mx-auto w-full max-w-[860px]">
        {!items.length ? (
          <p className="px-4 py-12 text-center text-sm text-fg-muted">{t("noActivity")}</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.key} className="border-b border-border/60 pb-1 last:border-0">
                {item.reaction && (
                  <p className="flex items-center gap-1.5 px-4 pt-2 text-xs text-fg-muted">
                    <span className="flex -space-x-1 rtl:space-x-reverse">
                      {[...new Set(item.reaction.map((r) => r.userId))].slice(0, 3).map((id) => (
                        <PersonFace key={id} s={view} userId={id} size="xs" presence={false} />
                      ))}
                    </span>
                    {t("reactedToYou", {
                      people: [...new Set(item.reaction.map((r) => view.people.get(r.userId)?.name ?? t("someone")))].join(", "),
                      emoji: [...new Set(item.reaction.map((r) => r.emoji))].join(" "),
                    })}
                    <span>· {format.relativeTime(new Date(item.at), now)}</span>
                  </p>
                )}
                <Where c={view.channels.get(item.m.channelId)} m={item.m} workspaceId={workspaceId} onOpen={() => openMessage(workspaceId, item.m)} />
                <MessageItem m={item.m} continued={false} ctx={ctx} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Messages saved for later, with their reminders; done ones apart. */
function SavedView({ workspaceId, ctx }: { workspaceId: string; ctx: ItemContext }) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const saved = useMessages((s) => s.saved);
  const messages = useMessages((s) => s.messages);
  const view = useView();
  const [done, setDone] = useState(false);
  const list = useMemo(() => [...saved.values()].filter((x) => !!x.doneAt === done).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [saved, done]);
  useEffect(() => {
    void loadMessages(list.map((x) => x.messageId));
  }, [list]);
  return (
    <>
      <ViewHead icon={<Bookmark />} title={t("views.saved")}>
        <Segmented value={done ? "done" : "open"} onChange={(v) => setDone(v === "done")} options={[["open", t("savedOpen")], ["done", t("savedDone")]]} />
      </ViewHead>
      <div className="mx-auto w-full max-w-[860px]">
        {!list.length ? (
          <p className="px-4 py-12 text-center text-sm text-fg-muted">{done ? t("noSavedDone") : t("noSaved")}</p>
        ) : (
          <ul>
            {list.map((x) => {
              const m = messages.get(x.messageId);
              const overdue = x.remindAt && new Date(x.remindAt) < new Date();
              return (
                <li key={x.messageId} className="group border-b border-border/60 pb-1 last:border-0">
                  <div className="flex items-center gap-2 pe-4">
                    <div className="min-w-0 flex-1">{m && <Where c={view.channels.get(m.channelId)} m={m} workspaceId={workspaceId} onOpen={() => openMessage(workspaceId, m)} />}</div>
                    {x.remindAt && !x.doneAt && (
                      <span className={cn("flex items-center gap-1 pt-2 text-xs", overdue ? "font-medium text-danger" : "text-fg-muted")}>
                        <Clock className="h-3 w-3" />
                        {new Date(x.remindAt).toLocaleString(locale, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void call("save", { messageId: x.messageId, done: !x.doneAt }).catch(() => {})}
                      title={x.doneAt ? t("savedReopen") : t("savedMarkDone")}
                      aria-label={x.doneAt ? t("savedReopen") : t("savedMarkDone")}
                      className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      {x.doneAt ? <Undo2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void call("save", { messageId: x.messageId, saved: false }).catch(() => {})}
                      title={t("actions.unsave")}
                      aria-label={t("actions.unsave")}
                      className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {m ? <MessageItem m={m} continued={false} ctx={ctx} /> : <p className="px-4 py-2 text-sm text-fg-faint">{t("loading")}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/** Unsent words: drafts left in boxes and messages scheduled to go later. */
function DraftsView({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const drafts = useMessages((s) => s.drafts);
  const scheduled = useMessages((s) => s.scheduled);
  const view = useView();
  const [what, setWhat] = useState<"drafts" | "scheduled">(() => (drafts.size || !scheduled.size ? "drafts" : "scheduled"));
  const title = (channelId: string) => {
    const c = view.channels.get(channelId);
    return c ? channelTitle(view, c, { you: t("you"), someone: t("someone") }) : t("someChannel");
  };
  const draftList = [...drafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const scheduledList = [...scheduled.values()].sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  return (
    <>
      <ViewHead icon={<SendHorizontal />} title={t("views.drafts")}>
        <Segmented
          value={what}
          onChange={setWhat}
          options={[
            ["drafts", `${t("drafts")}${drafts.size ? ` ${drafts.size}` : ""}`],
            ["scheduled", `${t("scheduled")}${scheduled.size ? ` ${scheduled.size}` : ""}`],
          ]}
        />
      </ViewHead>
      <div className="mx-auto w-full max-w-[860px] px-2">
        {what === "drafts" ? (
          !draftList.length ? (
            <p className="px-4 py-12 text-center text-sm text-fg-muted">{t("noDrafts")}</p>
          ) : (
            <ul>
              {draftList.map((d) => (
                <li key={`${d.channelId}:${d.threadId}`} className="group flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-bg-hover">
                  <a
                    href={messagesPath(workspaceId, { channelId: d.channelId, threadId: d.threadId || null })}
                    onClick={(e) => {
                      e.preventDefault();
                      go(messagesPath(workspaceId, { channelId: d.channelId, threadId: d.threadId || null }));
                    }}
                    className="min-w-0 flex-1"
                  >
                    <span className="block text-xs text-fg-muted">
                      {title(d.channelId)}
                      {d.threadId && ` · ${t("inThread")}`}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block">
                      <MessageBody body={d.body || t("filesOnly", { count: d.fileIds.length })} workspaceId={workspaceId} />
                    </span>
                  </a>
                  <button
                    type="button"
                    onClick={() => void call("draft", { channelId: d.channelId, threadId: d.threadId || null, body: "", fileIds: [] }).catch(() => {})}
                    title={t("deleteDraft")}
                    aria-label={t("deleteDraft")}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger max-md:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : !scheduledList.length ? (
          <p className="px-4 py-12 text-center text-sm text-fg-muted">{t("noScheduled")}</p>
        ) : (
          <ul>
            {scheduledList.map((x) => (
              <li key={x.id} className="group flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-bg-hover">
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <Clock className="h-3 w-3" />
                    {t("sendsAt", { when: new Date(x.sendAt).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) })}
                    <span>· {title(x.channelId)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block">
                    <MessageBody body={x.body || t("filesOnly", { count: x.fileIds.length })} workspaceId={workspaceId} />
                  </span>
                  {x.failure && <span className="mt-0.5 block text-xs text-danger">{t("scheduledFailed", { reason: t(`errors.${x.failure as "internal"}`) })}</span>}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void call("cancel", { id: x.id }).then(
                      () => showToast({ message: t("scheduledCancelled") }),
                      () => {},
                    )
                  }
                  title={t("cancelScheduled")}
                  aria-label={t("cancelScheduled")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger max-md:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Search across every channel the person may read, with `from:`, `in:`, `has:` and days. */
function SearchView({ workspaceId, ctx, query }: { workspaceId: string; ctx: ItemContext; query: string }) {
  const t = useTranslations("messages");
  const view = useView();
  const [text, setText] = useState(query);
  const [result, setResult] = useState<{ for: string; messages: MessageView[]; more: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => setText(query), [query]);
  const parsed = useMemo(
    () =>
      parseMessageSearch(query, {
        person: (name) => {
          if (name.toLowerCase() === "me") return view.me;
          const q = fold(name.replace(/_/g, " "));
          const found = [...view.people.values()].find((p) => fold(p.name) === q || fold(p.email) === q || fold(p.email.split("@")[0]) === q);
          return found?.id ?? [...view.people.values()].find((p) => fold(p.name).startsWith(q))?.id ?? null;
        },
        channel: (name) => [...view.channels.values()].find((c) => c.kind !== "direct" && fold(c.name ?? "") === fold(name))?.id ?? null,
      }),
    [query, view],
  );
  const run = (cursor?: string) => {
    if (!searchAsks(parsed)) return;
    setLoading(true);
    void call<{ messages: MessageView[]; more: boolean }>("search", { ...parsed, cursor })
      .then(
        (r) => {
          putMessages(r.messages);
          setResult((prev) => ({ for: query, messages: cursor && prev ? [...prev.messages, ...r.messages] : r.messages, more: r.more }));
        },
        () => showToast({ message: t("errors.internal") }),
      )
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setResult(null);
    run();
  }, [parsed]); // eslint-disable-line react-hooks/exhaustive-deps
  const messages = useMessages((s) => s.messages);
  const list = (result?.messages ?? []).map((m) => messages.get(m.id) ?? m).filter((m) => !m.deletedAt);
  return (
    <>
      <div className="mx-auto w-full max-w-[860px] px-4 pt-6 pb-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(messagesPath(workspaceId, { view: "search", query: text.trim() }));
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
          <Input ref={field} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} className="h-10 ps-9 text-[15px]" />
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SEARCH_HAS.map((h) => {
            const on = parsed.has.includes(h);
            return (
              <button
                key={h}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? query.replace(new RegExp(`\\s*has:${h}\\b`, "i"), "") : `${query} has:${h}`;
                  go(messagesPath(workspaceId, { view: "search", query: next.trim() }));
                }}
                className={cn("h-7 rounded-md border px-2 text-xs", on ? "border-accent bg-accent/10 text-fg" : "border-border text-fg-muted hover:bg-bg-hover hover:text-fg")}
              >
                {t(`has.${h}`)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-fg-faint">{t("searchHint")}</p>
      </div>
      <div className="mx-auto w-full max-w-[860px]">
        {!searchAsks(parsed) ? null : !result || result.for !== query ? (
          <Spinner />
        ) : (
          <>
            <Results list={list} workspaceId={workspaceId} ctx={ctx} empty={t("noResults")} />
            {result.more && (
              <div className="flex justify-center py-4">
                <button type="button" disabled={loading} onClick={() => run(result.messages.at(-1)?.createdAt)} className="text-sm text-accent hover:underline disabled:opacity-50">
                  {loading ? t("loading") : t("loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" className="flex rounded-md bg-bg-active p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={cn("h-6 rounded px-2 text-xs whitespace-nowrap", value === key ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-12 text-fg-faint">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

/** One of Messages' places beside the channels. */
export function MessagesViewPage({ view, workspaceId, query, forward, owner }: { view: Exclude<MessagesView, "browse">; workspaceId: string; query: string; forward: (id: string) => void; owner: boolean }) {
  const ctx = useResultContext(workspaceId, forward, owner);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-8">
      {view === "threads" ? (
        <ThreadsView workspaceId={workspaceId} ctx={ctx} />
      ) : view === "activity" ? (
        <ActivityView workspaceId={workspaceId} ctx={ctx} />
      ) : view === "saved" ? (
        <SavedView workspaceId={workspaceId} ctx={ctx} />
      ) : view === "drafts" ? (
        <DraftsView workspaceId={workspaceId} />
      ) : (
        <SearchView workspaceId={workspaceId} ctx={ctx} query={query} />
      )}
    </div>
  );
}
