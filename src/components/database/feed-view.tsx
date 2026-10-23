"use client";

import { MessageSquare, SmilePlus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { changeCommentsAction } from "@/app/actions/comments";
import { feedBodyAction, feedPostsAction, setReactionAction } from "@/app/actions/feed";
import { useChannel } from "@/components/collab/use-channel";
import { UserAvatar } from "@/components/user-avatar";
import { Button, cn, PageIcon, Popover, textareaClass } from "@/components/ui";
import type { CommentBody } from "@/lib/comments";
import { FEED_PAGE_SIZE, REACTION_EMOJIS, type PostReaction } from "@/lib/feed";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView } from "@/lib/properties";
import { relativeTime } from "@/lib/relative-time";
import type { CommentUser } from "@/server/comments";
import type { FeedComment, FeedPost, FeedThread } from "@/server/feed";
import { FeedMarkdown } from "./feed-markdown";
import { RowValue, shownValues } from "./property-cell";
import { openRowProps, useIsOpenRow, useRowOpener } from "./row-panel-context";
import type { Property, Row, View } from "./types";

/** Events on a database's channel after which the posts on screen are read again. */
const REFRESH_ON = new Set(["rows", "reactions", "comments"]);
/** Comments a post shows before "Show all comments". */
const SHOWN_COMMENTS = 3;

type People = Record<string, CommentUser>;

/**
 * A feed view (see lib/feed): the view's rows as posts in one readable column, a page of them at a
 * time. The rows come sorted from the database page (newest first unless the view sorts, see
 * lib/views withViewSorts); their bodies, reactions and comments are read here for the posts shown.
 * Loaded on its own when a feed opens: it brings the Markdown renderer along.
 */
export default function FeedView({
  workspaceId,
  databaseId,
  view,
  properties,
  rows,
  readOnly,
  canComment,
}: {
  workspaceId: string;
  databaseId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  readOnly?: boolean;
  /** The viewer may comment on and react to the posts (comment access, online, not in the trash). */
  canComment: boolean;
}) {
  const t = useTranslations("database.feed");
  const [limit, setLimit] = useState(FEED_PAGE_SIZE);
  const shown = useMemo(() => rows.slice(0, limit), [rows, limit]);
  const shownProps = useMemo(() => properties.filter((p) => !isHiddenInView(view, p)), [properties, view]);
  const ids = useMemo(() => shown.map((r) => r.id), [shown]);
  const { posts, people, error, setError, refresh, setPost } = useFeedPosts(databaseId, ids);

  const latestPosts = useRef(posts);
  latestPosts.current = posts;
  const react = useCallback(
    async (rowId: string, emoji: string, on: boolean) => {
      try {
        const res = await setReactionAction(rowId, emoji, on);
        if (!res.ok) return setError(res.error);
        setPost(rowId, (post) => ({ ...post, reactions: res.data }));
        // The new reaction's author may be someone the feed hasn't named yet: the viewer.
        if (on) void refresh([rowId]);
      } catch {
        setError(t("errors.failed"));
      }
    },
    [setPost, setError, refresh, t],
  );
  // A comment joins the post's conversation (its first open thread about the whole row), or starts it.
  const comment = useCallback(
    async (rowId: string, text: string) => {
      const thread = latestPosts.current[rowId]?.threads.find((th) => th.quote === null);
      try {
        const res = await changeCommentsAction(
          rowId,
          thread ? { type: "addComment", threadId: thread.id, body: text } : { type: "createThread", body: text },
        );
        if (!res.ok) {
          setError(t(`errors.${res.code === "tooLong" ? "tooLong" : res.code === "notAllowed" ? "notAllowed" : "failed"}`));
          return false;
        }
        await refresh([rowId]);
        return true;
      } catch {
        setError(t("errors.failed"));
        return false;
      }
    },
    [refresh, setError, t],
  );

  return (
    <div className="page-gutter pb-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {shown.map((row) => (
          <MemoFeedPost
            key={row.id}
            workspaceId={workspaceId}
            row={row}
            post={posts[row.id]}
            people={people}
            props={shownProps}
            canComment={canComment}
            onReact={react}
            onComment={comment}
          />
        ))}
        {!rows.length && <p className="py-10 text-center text-sm text-fg-muted">{t(readOnly ? "empty" : "emptyCanPost")}</p>}
        {rows.length > shown.length && (
          <Button size="sm" variant="ghost" className="self-center" onClick={() => setLimit((n) => n + FEED_PAGE_SIZE)}>
            {t("morePosts", { count: rows.length - shown.length })}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The posts' bodies, reactions and comments, for the rows shown: each read once when it shows up,
 * and again when the database says its rows, reactions or comments changed. A post that reads the
 * same keeps its object, so it doesn't redraw.
 */
function useFeedPosts(databaseId: string, ids: string[]) {
  const t = useTranslations("database.feed");
  const [posts, setPosts] = useState<Record<string, FeedPost>>({});
  const [people, setPeople] = useState<People>({});
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(new Set<string>());
  const shownIds = useRef(ids);
  shownIds.current = ids;

  const refresh = useCallback(
    async (which?: string[]) => {
      const wanted = which ?? shownIds.current;
      if (!wanted.length) return;
      for (const id of wanted) loaded.current.add(id);
      try {
        const res = await feedPostsAction(databaseId, wanted);
        if (!res.ok) return setError(res.error);
        setPosts((current) => {
          let next = current;
          for (const post of res.data.posts) {
            if (JSON.stringify(current[post.id]) === JSON.stringify(post)) continue;
            if (next === current) next = { ...current };
            next[post.id] = post;
          }
          return next;
        });
        setPeople((current) => {
          const fresh = res.data.people.filter((p) => JSON.stringify(current[p.id]) !== JSON.stringify(p));
          return fresh.length ? { ...current, ...Object.fromEntries(fresh.map((p) => [p.id, p])) } : current;
        });
      } catch {
        // Offline, or the session ended: the posts show without their bodies until the next change.
        for (const id of wanted) loaded.current.delete(id);
        setError(t("errors.failed"));
      }
    },
    [databaseId, t],
  );

  // Rows that just showed up (the first page, more posts, a new row) are read once.
  const idsKey = ids.join(",");
  useEffect(() => {
    const missing = idsKey ? idsKey.split(",").filter((id) => !loaded.current.has(id)) : [];
    if (missing.length) void refresh(missing);
  }, [idsKey, refresh]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(`db:${databaseId}`, (event) => {
    if (!REFRESH_ON.has(event)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 300);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const setPost = useCallback((id: string, change: (post: FeedPost) => FeedPost) => {
    setPosts((current) => (current[id] ? { ...current, [id]: change(current[id]) } : current));
  }, []);

  return { posts, people, error, setError, refresh, setPost };
}

const MemoFeedPost = memo(FeedPostView);

/** One post: who wrote it and when, its title and values, its body, then reactions and comments. */
function FeedPostView({
  workspaceId,
  row,
  post,
  people,
  props,
  canComment,
  onReact,
  onComment,
}: {
  workspaceId: string;
  row: Row;
  /** Still loading while missing. */
  post: FeedPost | undefined;
  people: People;
  props: Property[];
  canComment: boolean;
  onReact: (rowId: string, emoji: string, on: boolean) => Promise<void>;
  onComment: (rowId: string, text: string) => Promise<boolean>;
}) {
  const t = useTranslations("database.feed");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const opener = useRowOpener(workspaceId);
  const isOpen = useIsOpenRow(opener, row.id);
  const shown = shownValues(props, row);
  const author = row.createdBy ? people[row.createdBy] : undefined;
  const authorName = author?.username ?? t("someone");
  const createdAt = new Date(row.createdAt);
  const label = pageLabel(row.title, tc("untitled"));

  return (
    <article aria-label={label} className={cn("rounded-lg border border-border bg-bg px-4 py-3 sm:px-5 sm:py-4", isOpen && "border-fg-faint")}>
      <header className="flex items-center gap-2 text-sm">
        {author?.isAgent && author.agentIcon ? (
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-active text-xs">
            {author.agentIcon}
          </span>
        ) : (
          <UserAvatar name={authorName} image={author?.avatarUrl} size="sm" />
        )}
        <bdi className="min-w-0 truncate font-medium">{authorName}</bdi>
        <span aria-hidden className="text-fg-faint">
          ·
        </span>
        <time
          dateTime={createdAt.toISOString()}
          title={format.dateTime(createdAt, { dateStyle: "full", timeStyle: "short" })}
          className="shrink-0 text-xs text-fg-faint"
        >
          {relativeTime(createdAt, locale)}
        </time>
      </header>
      <h3 className="mt-2">
        <a
          href={opener.href(row.id)}
          {...openRowProps(opener, row.id, true)}
          onClick={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            opener.open(row.id, e);
          }}
          className="inline-flex max-w-full items-start gap-1.5 rounded-sm text-lg leading-snug font-semibold hover:underline"
        >
          {row.icon && <PageIcon icon={row.icon} className="shrink-0" />}
          <span className={cn("min-w-0 break-words", !row.title && "text-fg-faint")}>{label}</span>
        </a>
      </h3>
      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
          {shown.map((p) => (
            <span key={p.id} className="flex max-w-full min-w-0 items-center" title={p.name}>
              <RowValue prop={p} row={row} />
            </span>
          ))}
        </div>
      )}
      {post ? (
        <>
          {post.excerpt && <PostBody rowId={row.id} excerpt={post.excerpt} more={post.more} />}
          <Reactions rowId={row.id} reactions={post.reactions} people={people} canReact={canComment} onReact={onReact} />
          <Comments rowId={row.id} threads={post.threads} people={people} canComment={canComment} onComment={onComment} />
        </>
      ) : (
        <div aria-busy="true" aria-label={tc("loading")} className="mt-3 h-12 animate-pulse rounded-md bg-bg-subtle" />
      )}
    </article>
  );
}

/** The body's first part, and the rest in place on "Show more". */
function PostBody({ rowId, excerpt, more }: { rowId: string; excerpt: string; more: boolean }) {
  const t = useTranslations("database.feed");
  const [full, setFull] = useState<{ markdown: string; cut: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A changed body is read again when it is opened next.
  useEffect(() => setFull(null), [excerpt]);

  const showMore = async () => {
    setFailed(false);
    if (full) return setExpanded(true);
    setLoading(true);
    try {
      const res = await feedBodyAction(rowId);
      if (!res.ok) return setFailed(true);
      setFull(res.data);
      setExpanded(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3">
      <FeedMarkdown markdown={expanded && full ? full.markdown : excerpt} />
      {expanded && full?.cut && <p className="mt-2 text-xs text-fg-faint">{t("bodyCut")}</p>}
      {(more || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          disabled={loading}
          onClick={() => (expanded ? setExpanded(false) : void showMore())}
          className="mt-1 rounded-sm text-sm font-medium text-fg-muted hover:text-fg hover:underline disabled:opacity-60"
        >
          {t(expanded ? "showLess" : "showMore")}
        </button>
      )}
      {failed && <p className="mt-1 text-xs text-danger">{t("errors.failed")}</p>}
    </div>
  );
}

/** The row's reactions as chips (the viewer's own pressed), and a button to add one. */
function Reactions({
  rowId,
  reactions,
  people,
  canReact,
  onReact,
}: {
  rowId: string;
  reactions: PostReaction[];
  people: People;
  canReact: boolean;
  onReact: (rowId: string, emoji: string, on: boolean) => Promise<void>;
}) {
  const t = useTranslations("database.feed");
  const format = useFormatter();
  if (!reactions.length && !canReact) return null;
  const names = (r: PostReaction) =>
    format.list(
      r.userIds.slice(0, 10).map((id) => people[id]?.username ?? t("someone")),
      { type: "conjunction" },
    );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.mine}
          disabled={!canReact}
          title={t("reactedBy", { names: names(r), emoji: r.emoji })}
          onClick={() => void onReact(rowId, r.emoji, !r.mine)}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-sm disabled:cursor-default",
            r.mine ? "border-accent bg-accent/10" : "border-border hover:bg-bg-hover",
          )}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="text-xs text-fg-muted">{r.count}</span>
          <span className="sr-only">{t("reactionCount", { emoji: r.emoji, count: r.count })}</span>
        </button>
      ))}
      {canReact && (
        <Popover
          align="start"
          className="w-auto"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              aria-label={t("addReaction")}
              title={t("addReaction")}
              aria-expanded={open}
              onClick={toggle}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <SmilePlus className="h-4 w-4" />
            </button>
          )}
        >
          {(close) => (
            <div role="group" aria-label={t("addReaction")} className="flex gap-0.5 p-1">
              {REACTION_EMOJIS.map((emoji) => {
                const mine = reactions.some((r) => r.emoji === emoji && r.mine);
                return (
                  <button
                    key={emoji}
                    type="button"
                    aria-pressed={mine}
                    onClick={() => {
                      close();
                      void onReact(rowId, emoji, !mine);
                    }}
                    className={cn("flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-bg-hover", mine && "bg-bg-active")}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

/** The row's open comments, the last few unless all are asked for, and a box to add one. */
function Comments({
  rowId,
  threads,
  people,
  canComment,
  onComment,
}: {
  rowId: string;
  threads: FeedThread[];
  people: People;
  canComment: boolean;
  onComment: (rowId: string, text: string) => Promise<boolean>;
}) {
  const t = useTranslations("database.feed");
  const [all, setAll] = useState(false);
  const total = threads.reduce((n, th) => n + th.comments.length, 0);
  if (!total && !canComment) return null;
  // The last comments, oldest of them first; a thread keeps the text it quotes above its first one.
  let skip = all ? 0 : Math.max(0, total - SHOWN_COMMENTS);
  const shown = threads.flatMap((thread) => {
    const comments = thread.comments.slice(Math.min(skip, thread.comments.length));
    skip = Math.max(0, skip - thread.comments.length);
    return comments.length ? [{ thread, comments, quote: comments[0] === thread.comments[0] ? thread.quote : null }] : [];
  });
  return (
    <section aria-label={t("comments")} className="mt-3 border-t border-border pt-3">
      {total > SHOWN_COMMENTS && !all && (
        <button type="button" onClick={() => setAll(true)} className="mb-2 flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg hover:underline">
          <MessageSquare className="h-3.5 w-3.5" />
          {t("allComments", { count: total })}
        </button>
      )}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {shown.map(({ thread, comments, quote }) => (
            <li key={thread.id} className="flex flex-col gap-2.5">
              {quote && <p className="border-s-2 border-border ps-2 text-xs text-fg-muted">{quote}</p>}
              {comments.map((c) => (
                <FeedCommentView key={c.id} comment={c} person={people[c.userId]} />
              ))}
            </li>
          ))}
        </ul>
      )}
      {canComment && <CommentBox onSubmit={(text) => onComment(rowId, text)} />}
    </section>
  );
}

function FeedCommentView({ comment, person }: { comment: FeedComment; person?: CommentUser }) {
  const t = useTranslations("database.feed");
  const locale = useLocale();
  const name = person?.username ?? t("someone");
  const at = new Date(comment.createdAt);
  return (
    <div className="flex items-start gap-2 text-sm">
      {person?.isAgent && person.agentIcon ? (
        <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-active text-[11px]">
          {person.agentIcon}
        </span>
      ) : (
        <UserAvatar name={name} image={person?.avatarUrl} size="xs" className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <bdi className="font-medium">{name}</bdi>{" "}
          <time dateTime={comment.createdAt} className="text-fg-faint">
            {relativeTime(at, locale)}
          </time>
        </p>
        <CommentText body={comment.body} />
      </div>
    </div>
  );
}

/** A comment's paragraphs with their styles and links (see lib/comments CommentBody). */
function CommentText({ body }: { body: CommentBody | null }) {
  if (!body) return null;
  return (
    <div className="break-words whitespace-pre-wrap">
      {body.map((paragraph, i) => (
        <p key={i}>
          {paragraph.content.map((node, j): ReactNode => {
            if (node.type === "link") {
              return (
                <a key={j} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                  {node.content.map((text) => text.text).join("")}
                </a>
              );
            }
            const s = node.styles;
            return (
              <span
                key={j}
                className={cn(
                  s.bold && "font-semibold",
                  s.italic && "italic",
                  (s.underline || s.strike) && [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" "),
                  s.code && "rounded bg-bg-subtle px-1 font-mono text-[0.9em]",
                )}
              >
                {node.text}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

/** Writes a comment: Enter with Ctrl or ⌘ sends it, as the button does. */
function CommentBox({ onSubmit }: { onSubmit: (text: string) => Promise<boolean> }) {
  const t = useTranslations("database.feed");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await onSubmit(text);
    setSending(false);
    if (ok) setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
  };
  return (
    <form onSubmit={(e) => void send(e)} className="mt-3 flex items-end gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={t("commentPlaceholder")}
        aria-label={t("commentPlaceholder")}
        className={cn(textareaClass, "min-h-8 flex-1 resize-y py-1.5 text-sm")}
      />
      <Button type="submit" size="sm" disabled={!text.trim() || sending}>
        {t("send")}
      </Button>
    </form>
  );
}
