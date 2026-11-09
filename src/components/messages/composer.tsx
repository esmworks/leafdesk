"use client";

import { AtSign, Bold, ChartBarBig, ChevronDown, Clock, Code, FileText, Hash, Italic, Loader2, Paperclip, SendHorizontal, SmilePlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadEmojiData, searchEmoji, type EmojiData } from "@/components/icon-picker/emoji-data";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { showToast } from "@/components/toast";
import { cn, MenuItem, Popover } from "@/components/ui";
import { MENTION_SCHEME, refLink, type MessageRef } from "@/lib/message-text";
import type { FileView } from "@/lib/message-wire";
import { MESSAGE_LIMITS } from "@/lib/messages";
import { EmojiPicker, rememberEmoji } from "./emoji-picker";
import { PersonFace } from "./person";
import { call, channelTitle, draftKey, messagesState, sendMessage, typing, useMessages, useView, MessagesError } from "./store";

/**
 * Where a message is written: plain text with Markdown, where people (@), channels (#), pages ([[)
 * and emoji (:) are picked from a list. A picked person shows as `@Name` in the text and is kept
 * as a reference beside it; sending (and the draft, kept on the server as the person types) writes
 * each as its link (lib/message-text.ts), so the text reads the same everywhere.
 *
 * Enter sends, Shift+Enter starts a new line, ↑ in an empty box edits the person's last message.
 */

/** Writing a poll, loaded the first time someone opens it. */
const PollDialog = lazyPart(() => import("./poll-dialog").then((m) => m.PollDialog));

type Token = { text: string; ref: MessageRef };
type Upload = { key: string; name: string; file?: FileView; failed?: boolean };

/** The body as stored: each token's text, where it still stands whole, becomes its link. */
export function encodeBody(text: string, tokens: Token[]): string {
  let out = text;
  // Longer first, so "@Ann Lee" isn't taken as "@Ann".
  for (const token of [...tokens].sort((a, b) => b.text.length - a.text.length)) {
    const link = refLink(token.ref, token.text);
    let at = 0;
    for (;;) {
      const i = out.indexOf(token.text, at);
      if (i < 0) break;
      const after = out[i + token.text.length];
      // Whole only: not inside a longer word, and not already a link's words.
      if ((after && /[\p{L}\p{N}_]/u.test(after)) || out[i - 1] === "[") {
        at = i + token.text.length;
        continue;
      }
      out = out.slice(0, i) + link + out.slice(i + token.text.length);
      at = i + link.length;
    }
  }
  return out;
}

const LINK = /\[([^\]\n]{0,200})\]\((leafdesk:[^)\s]{1,200})\)/g;

/** A stored body back into the box's text and its tokens (a draft, a message edited). */
export function decodeBody(body: string): { text: string; tokens: Token[] } {
  const tokens: Token[] = [];
  const text = body.replace(LINK, (whole, label: string, href: string) => {
    const rest = href.slice(MENTION_SCHEME.length);
    const [kind, id] = rest.split("/");
    const ref: MessageRef | null =
      rest === "here" || rest === "everyone" ? { kind: rest } : kind === "user" || kind === "channel" || kind === "page" ? { kind, id } : null;
    if (!ref) return whole;
    tokens.push({ text: label, ref });
    return label;
  });
  return { text, tokens };
}

type Suggestion = { key: string; label: string; detail?: string; icon: React.ReactNode; insert: string; token?: Token };

/** The word being typed before the caret that asks for suggestions, if any. */
function trigger(text: string, caret: number): { kind: "@" | "#" | ":" | "[["; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const page = /\[\[([^\]\n]{0,60})$/.exec(before);
  if (page) return { kind: "[[", query: page[1], start: caret - page[0].length };
  const m = /(^|[\s(])([@#:])([\p{L}\p{N}_.\- ]{0,40})$/u.exec(before);
  if (!m) return null;
  const kind = m[2] as "@" | "#" | ":";
  const query = m[3];
  // A space ends a channel's or an emoji's name; a person's may have one, but not two in a row.
  if ((kind !== "@" && query.includes(" ")) || query.includes("  ")) return null;
  if (kind === ":" && query.length < 2) return null;
  return { kind, query, start: caret - query.length - 1 };
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export type ComposerHandle = { focus: () => void; insert: (text: string) => void };

export const Composer = forwardRef<
  ComposerHandle,
  {
    workspaceId: string;
    channelId: string;
    threadId?: string | null;
    placeholder: string;
    disabled?: string | null;
    /** ↑ in an empty box: edit the person's last message here. */
    onEditLast?: () => void;
    /** A message went (scrolls the list to it). */
    onSent?: () => void;
  }
>(function Composer({ workspaceId, channelId, threadId = null, placeholder, disabled, onEditLast, onSent }, ref) {
  const t = useTranslations("messages");
  const locale = useLocale();
  const view = useView();
  const draft = useMessages((s) => s.drafts.get(draftKey(channelId, threadId)));
  const ready = useMessages((s) => s.ready);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [emoji, setEmoji] = useState<EmojiData | null>(null);
  const [pages, setPages] = useState<{ query: string; hits: { id: string; title: string; icon: string | null }[] } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [dragging, setDragging] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSaved = useRef("");
  const selectAt = useRef<[number, number] | null>(null);

  // The draft kept for this place comes back when it opens (once per place: later changes are this box's own).
  useEffect(() => {
    const key = draftKey(channelId, threadId);
    if (!ready || loadedFor.current === key) return;
    loadedFor.current = key;
    const back = draft ? decodeBody(draft.body) : { text: "", tokens: [] };
    setText(back.text);
    setTokens(back.tokens);
    lastSaved.current = draft?.body ?? "";
    setUploads(draft?.fileIds.map((id) => ({ key: id, name: id, file: { id, url: "", name: t("file"), contentType: "", size: 0, width: null, height: null } })) ?? []);
  }, [channelId, threadId, ready, draft, t]);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    insert: (more: string) => {
      setText((x) => (x ? `${x} ${more}` : more));
      area.current?.focus();
    },
  }));

  // Grows with the text, up to a part of the window; puts the caret where a pick left it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    if (selectAt.current) {
      el.focus();
      el.setSelectionRange(...selectAt.current);
      selectAt.current = null;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const fileIds = uploads.flatMap((u) => (u.file ? [u.file.id] : []));
  const saveDraft = useCallback(
    (body: string, files: string[]) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const key = `${body}\n${files.join(",")}`;
        if (key === lastSaved.current) return;
        lastSaved.current = key;
        void call("draft", { channelId, threadId, body, fileIds: files }).catch(() => {});
      }, 800);
    },
    [channelId, threadId],
  );
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const found = closedAt === caret ? null : trigger(text, caret);
  useEffect(() => {
    if (found?.kind === ":" && !emoji) void loadEmojiData(locale).then(setEmoji);
  }, [found?.kind, emoji, locale]);
  const pageQuery = found?.kind === "[[" ? found.query : null;
  useEffect(() => {
    if (pageQuery === null) return;
    let gone = false;
    const timer = setTimeout(() => {
      const ask = pageQuery.trim() ? read("search", workspaceId, pageQuery) : read("recentSearch", workspaceId).then((r) => r.pages);
      void Promise.resolve(ask).then(
        (hits) => !gone && setPages({ query: pageQuery, hits: (hits as { id: string; title: string; icon: string | null }[]).slice(0, 8) }),
        () => {},
      );
    }, 150);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [pageQuery, workspaceId]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!found) return [];
    const q = fold(found.query.trim());
    if (found.kind === "@") {
      const channel = view.channels.get(channelId);
      const people = [...view.people.values()]
        .filter((p) => !q || fold(p.name).includes(q) || fold(p.email).startsWith(q))
        .sort((a, b) => Number(fold(b.name).startsWith(q)) - Number(fold(a.name).startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map<Suggestion>((p) => ({
          key: p.id,
          label: p.name || p.email,
          detail: p.agent ? t("agent") : p.email,
          icon: <PersonFace s={view} userId={p.id} size="xs" />,
          insert: `@${p.name || p.email}`,
          token: { text: `@${p.name || p.email}`, ref: { kind: "user", id: p.id } },
        }));
      const broadcast: Suggestion[] =
        channel && channel.kind !== "direct"
          ? (["here", "channel"] as const)
              .filter((k) => !q || k.startsWith(q))
              .map((k) => ({ key: k, label: `@${k}`, detail: t(k === "here" ? "mentionHere" : "mentionChannel"), icon: <AtSign className="h-4 w-4 text-fg-icon" />, insert: `@${k}`, token: { text: `@${k}`, ref: { kind: k === "here" ? "here" : "everyone" } } }))
          : [];
      return [...people, ...broadcast];
    }
    if (found.kind === "#") {
      return [...view.channels.values()]
        .filter((c) => c.kind !== "direct" && !c.archivedAt && (!q || fold(c.name ?? "").includes(q)))
        .slice(0, 8)
        .map((c) => {
          const name = `#${channelTitle(view, c, { you: t("you"), someone: t("someone") })}`;
          return { key: c.id, label: name, detail: c.topic, icon: <Hash className="h-4 w-4 text-fg-icon" />, insert: name, token: { text: name, ref: { kind: "channel", id: c.id } } };
        });
    }
    if (found.kind === ":") {
      if (!emoji) return [];
      return searchEmoji(emoji, found.query, 8).map((e) => ({ key: e.emoji, label: emoji.labels.get(e.emoji) ?? e.emoji, icon: <span className="text-base leading-none">{e.emoji}</span>, insert: e.emoji }));
    }
    if (!pages || pages.query !== found.query) return [];
    return pages.hits.map((p) => {
      const title = p.title || t("untitled");
      return { key: p.id, label: title, icon: <FileText className="h-4 w-4 text-fg-icon" />, insert: title, token: { text: title, ref: { kind: "page", id: p.id } } };
    });
  }, [found, view, channelId, emoji, pages, t]);

  const choose = (sug: Suggestion) => {
    if (!found) return;
    const insert = `${sug.insert} `;
    const next = text.slice(0, found.start) + insert + text.slice(caret);
    setText(next);
    if (sug.token) setTokens((list) => [...list.filter((x) => x.text !== sug.token!.text), sug.token!]);
    if (found.kind === ":") rememberEmoji(sug.insert);
    const at = found.start + insert.length;
    // The caret goes after what was put in once the text is drawn; the list stays shut there.
    selectAt.current = [at, at];
    setCaret(at);
    setClosedAt(at);
    setPicked(0);
    saveDraft(encodeBody(next, sug.token ? [...tokens, sug.token] : tokens), fileIds);
  };

  const upload = async (files: File[]) => {
    const room = MESSAGE_LIMITS.files - uploads.length;
    for (const f of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      setUploads((list) => [...list, { key, name: f.name }]);
      let size = "";
      if (f.type.startsWith("image/")) {
        try {
          const bitmap = await createImageBitmap(f);
          size = `${bitmap.width}x${bitmap.height}`;
          bitmap.close();
        } catch {}
      }
      try {
        const response = await fetch(`/api/messages/files?channelId=${encodeURIComponent(channelId)}`, {
          method: "POST",
          headers: { "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name), ...(size ? { "X-Image-Size": size } : {}) },
          body: f,
        });
        const data = (await response.json()) as FileView & { error?: string };
        if (!response.ok) throw new Error(data.error ?? String(response.status));
        setUploads((list) => {
          const next = list.map((u) => (u.key === key ? { ...u, file: data } : u));
          saveDraft(encodeBody(text, tokens), next.flatMap((u) => (u.file ? [u.file.id] : [])));
          return next;
        });
      } catch (error) {
        setUploads((list) => list.map((u) => (u.key === key ? { ...u, failed: true } : u)));
        showToast({ message: t("uploadFailed", { name: f.name, reason: error instanceof Error ? error.message : "" }) });
      }
    }
  };

  const busy = uploads.some((u) => !u.file && !u.failed);
  const empty = !text.trim() && !fileIds.length;

  const clear = () => {
    setText("");
    setTokens([]);
    setUploads([]);
    setAlsoInChannel(false);
    clearTimeout(saveTimer.current);
    // A send drops the draft on the server; a scheduled message doesn't, so the box says it is empty.
    if (lastSaved.current || messagesState().drafts.has(draftKey(channelId, threadId))) void call("draft", { channelId, threadId, body: "", fileIds: [] }).catch(() => {});
    lastSaved.current = "";
  };

  const send = () => {
    if (empty || busy || disabled) return;
    const body = encodeBody(text.trimEnd(), tokens);
    if (body.length > MESSAGE_LIMITS.body) return showToast({ message: t("errors.tooLong") });
    const files = fileIds;
    clear();
    onSent?.();
    void sendMessage({ channelId, threadId, body, fileIds: files, alsoInChannel: !!threadId && alsoInChannel }).then(
      (result) => {
        const outside = result?.notInChannel ?? [];
        if (outside.length) {
          const names = outside.map((id) => messagesState().people.get(id)?.name ?? t("someone")).join(", ");
          showToast({
            message: t("notInChannel", { people: names, count: outside.length }),
            action: { label: t("addThem", { count: outside.length }), run: () => void call("add", { channelId, userIds: outside }).catch(() => showToast({ message: t("errors.notAllowed") })) },
          });
        }
      },
      (error) => {
        if (error instanceof MessagesError) showToast({ message: t(`errors.${error.code as "internal"}`) });
      },
    );
  };

  const schedule = (at: Date) => {
    if (empty || busy) return;
    const body = encodeBody(text.trimEnd(), tokens);
    const files = fileIds;
    clear();
    setScheduleOpen(false);
    void call("schedule", { channelId, threadId, body, fileIds: files, sendAt: at.toISOString() }).then(
      () => showToast({ message: t("scheduledFor", { when: at.toLocaleString(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }) }) }),
      () => showToast({ message: t("errors.internal") }),
    );
  };

  const wrap = (mark: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = `${text.slice(0, a)}${mark}${text.slice(a, b)}${mark}${text.slice(b)}`;
    selectAt.current = [a + mark.length, b + mark.length];
    setText(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(suggestions[Math.min(picked, suggestions.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosedAt(caret);
        return;
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      return wrap("**");
    }
    if (mod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      return wrap("_");
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "ArrowUp" && !text && onEditLast) {
      e.preventDefault();
      onEditLast();
    }
  };

  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  const nextMonday = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d;
  };

  const toolButton = "flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40";
  return (
    <div
      className={cn("relative rounded-xl border border-border bg-bg focus-within:border-fg-faint", dragging && "border-accent")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files") || disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (!e.dataTransfer.files.length || disabled) return;
        e.preventDefault();
        void upload([...e.dataTransfer.files]);
      }}
    >
      {suggestions.length > 0 && (
        <div role="listbox" className="absolute bottom-full start-0 z-20 mb-1 w-80 max-w-full rounded-lg border border-border bg-bg p-1 shadow-lg">
          {suggestions.map((sug, i) => (
            <button
              key={sug.key}
              type="button"
              role="option"
              aria-selected={i === picked}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(sug);
              }}
              onMouseEnter={() => setPicked(i)}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm", i === picked && "bg-bg-hover")}
            >
              <span className="flex w-5 shrink-0 justify-center">{sug.icon}</span>
              <span className="min-w-0 truncate text-fg">{sug.label}</span>
              {sug.detail && <span className="min-w-0 flex-1 truncate text-end text-xs text-fg-faint">{sug.detail}</span>}
            </button>
          ))}
        </div>
      )}
      {/* Over the window: a fixed dialog, here only so it shares the box's state. */}
      {pollOpen && <PollDialog channelId={channelId} threadId={threadId} alsoInChannel={alsoInChannel} close={() => setPollOpen(false)} onSent={() => onSent?.()} />}
      {disabled ? (
        <p className="px-3 py-3 text-sm text-fg-muted">{disabled}</p>
      ) : (
        <>
          <textarea
            ref={area}
            value={text}
            rows={1}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setClosedAt(null);
              setPicked(0);
              typing(channelId, threadId);
              saveDraft(encodeBody(e.target.value, tokens), fileIds);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              e.preventDefault();
              void upload(files);
            }}
            className="block max-h-[40vh] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint"
          />
          {uploads.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-1">
              {uploads.map((u) => (
                <span key={u.key} className={cn("flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-border px-2 text-xs", u.failed && "border-danger text-danger")}>
                  {!u.file && !u.failed ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 text-fg-icon" />}
                  <span className="truncate">{u.file?.name ?? u.name}</span>
                  <button
                    type="button"
                    aria-label={t("removeFile")}
                    onClick={() => {
                      const next = uploads.filter((x) => x.key !== u.key);
                      setUploads(next);
                      saveDraft(encodeBody(text, tokens), next.flatMap((x) => (x.file ? [x.file.id] : [])));
                    }}
                    className="text-fg-muted hover:text-fg"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <label className={cn(toolButton, "cursor-pointer")} title={t("attach")}>
              <Paperclip className="h-4 w-4" />
              <input
                type="file"
                multiple
                className="sr-only"
                aria-label={t("attach")}
                onChange={(e) => {
                  void upload([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => setPollOpen(true)}
              onPointerEnter={() => void PollDialog.preload()}
              aria-label={t("poll.create")}
              title={t("poll.create")}
              className={toolButton}
            >
              <ChartBarBig className="h-4 w-4" />
            </button>
            <Popover
              side="top"
              trigger={({ toggle }) => (
                <button type="button" onClick={toggle} aria-label={t("emoji")} title={t("emoji")} className={toolButton}>
                  <SmilePlus className="h-4 w-4" />
                </button>
              )}
            >
              {(close) => (
                <EmojiPicker
                  onPick={(e) => {
                    close();
                    const el = area.current;
                    const at = el?.selectionStart ?? text.length;
                    selectAt.current = [at + e.length, at + e.length];
                    setText(text.slice(0, at) + e + text.slice(at));
                  }}
                />
              )}
            </Popover>
            <button type="button" onClick={() => wrap("**")} aria-label={t("bold")} title={t("bold")} className={toolButton}>
              <Bold className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => wrap("_")} aria-label={t("italic")} title={t("italic")} className={toolButton}>
              <Italic className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => wrap("`")} aria-label={t("code")} title={t("code")} className={toolButton}>
              <Code className="h-4 w-4" />
            </button>
            {threadId && (
              <label className="ms-2 flex items-center gap-1.5 text-xs text-fg-muted">
                <input type="checkbox" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
                {t("alsoInChannel")}
              </label>
            )}
            <span className="flex-1" />
            <div className="flex items-center overflow-hidden rounded-md">
              <button
                type="button"
                onClick={send}
                disabled={empty || busy}
                aria-label={t("send")}
                title={t("send")}
                className={cn("flex h-7 items-center justify-center px-2", empty || busy ? "text-fg-faint" : "bg-primary text-primary-fg hover:opacity-90")}
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
              <Popover
                side="top"
                align="end"
                open={scheduleOpen}
                onOpenChange={setScheduleOpen}
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    disabled={empty || busy}
                    aria-label={t("scheduleSend")}
                    title={t("scheduleSend")}
                    className={cn("flex h-7 w-5 items-center justify-center border-s", empty || busy ? "border-transparent text-fg-faint" : "border-primary-fg/20 bg-primary text-primary-fg hover:opacity-90")}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                )}
              >
                <p className="px-2 py-1 text-xs font-medium text-fg-faint">{t("scheduleSend")}</p>
                <MenuItem icon={<Clock className="h-4 w-4" />} onClick={() => schedule(tomorrow())}>
                  {t("scheduleTomorrow", { when: tomorrow().toLocaleString(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }) })}
                </MenuItem>
                <MenuItem icon={<Clock className="h-4 w-4" />} onClick={() => schedule(nextMonday())}>
                  {t("scheduleMonday", { when: nextMonday().toLocaleString(locale, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) })}
                </MenuItem>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label={t("scheduleCustom")} className="h-7 flex-1 rounded-md border border-border bg-bg px-1 text-xs" />
                  <button type="button" disabled={!when} onClick={() => schedule(new Date(when))} className="h-7 rounded-md bg-primary px-2 text-xs font-medium text-primary-fg disabled:opacity-40">
                    {t("schedule")}
                  </button>
                </div>
              </Popover>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
