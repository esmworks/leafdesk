"use client";

import { SuggestionMenu } from "@blocknote/core/extensions";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  SuggestionMenuController,
  useExtension,
  useExtensionState,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { Bell, CalendarDays, ChevronRight, CircleUser, FilePlus, FileX2, Link2, Lock, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  backlinksAction,
  linkMentionAction,
  mentionCandidatesAction,
  pagesNamedAction,
  resolvePagesAction,
  unlinkedMentionsAction,
} from "@/app/actions/mentions";
import { createPageAction } from "@/app/actions/pages";
import { useChannel } from "@/components/collab/use-channel";
import { Button, cn, Dialog, PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import {
  formatIsoDate,
  isIsoDate,
  localIsoDate,
  localReminderAt,
  mentionConfig,
  mentionProps,
  newMentionId,
  pageLinkBlockConfig,
  pagePath,
  type MentionProps,
} from "@/lib/mentions";
import { LINK_PLACEHOLDER } from "@/lib/link-context";
import type { MentionCandidates, PageRef, UnlinkedMention } from "@/server/mentions";
import type { PageEditor } from "./embed-blocks";
import { searchFold } from "@/lib/search-fold";
import { linkWikilinks, titleKey, wikilinkTitles } from "@/lib/wikilinks";

/**
 * The editor's side of mentions and page links (configs shared with the server in lib/mentions):
 * the `@` menu, mention chips, the "Link to page" block and its picker, and the page's backlinks.
 */

// ---------------------------------------------------------------------------------------------
// Live titles of mentioned pages

/**
 * What the browser knows about mentioned pages, shared by every chip on the page: fetched in one
 * batch per render pass, and fetched again when the workspace's page tree changes (renames, icons,
 * the trash), so chips follow the pages they point at.
 */
const refs = new Map<string, PageRef>();
const listeners = new Set<() => void>();
const wanted = new Set<string>();
let batch: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

async function fetchRefs(ids: string[]) {
  if (!ids.length) return;
  try {
    for (const ref of await resolvePagesAction(ids)) refs.set(ref.id, ref);
    notify();
  } catch {
    // Offline or signed out: chips keep what they showed.
  }
}

function requestRef(id: string) {
  if (!id || refs.has(id) || wanted.has(id)) return;
  wanted.add(id);
  batch ??= setTimeout(() => {
    batch = null;
    const ids = [...wanted];
    wanted.clear();
    void fetchRefs(ids);
  }, 10);
}

/** Fetches every known page again (their titles, icons or access may have changed). */
export function refreshPageRefs() {
  void fetchRefs([...refs.keys()]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function usePageRef(pageId: string): PageRef | undefined {
  const ref = useSyncExternalStore(
    subscribe,
    () => refs.get(pageId),
    () => undefined,
  );
  useEffect(() => requestRef(pageId), [pageId]);
  return ref;
}

/** Keeps mentioned pages' titles live while a page of `workspaceId` is open. */
export function usePageRefUpdates(workspaceId: string) {
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "tree") refreshPageRefs();
  });
}

// ---------------------------------------------------------------------------------------------
// Chips

function openPage(event: MouseEvent, href: string, push: (href: string) => void) {
  // New tab and friends keep the browser's behaviour.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  push(href);
}

/** A mentioned page: its live icon and title, or a note that names nothing. */
function PageMentionChip({ pageId }: { pageId: string }) {
  const t = useTranslations("page.mention");
  const tc = useTranslations("common");
  const router = useRouter();
  const ref = usePageRef(pageId);
  if (!ref) {
    return (
      <span className="leafdesk-mention leafdesk-mention-page leafdesk-mention-muted">
        <Link2 className="leafdesk-mention-icon" aria-hidden />
        <span className="leafdesk-mention-label">{t("loading")}</span>
      </span>
    );
  }
  if (ref.status !== "ok") {
    const Icon = ref.status === "noAccess" ? Lock : FileX2;
    return (
      <span className="leafdesk-mention leafdesk-mention-page leafdesk-mention-muted" data-mention-status={ref.status}>
        <Icon className="leafdesk-mention-icon" aria-hidden />
        <span className="leafdesk-mention-label">{t(ref.status === "noAccess" ? "noAccess" : "deleted")}</span>
      </span>
    );
  }
  const href = pagePath(ref.workspaceId, ref.id);
  return (
    <a href={href} className="leafdesk-mention leafdesk-mention-page" onClick={(e) => openPage(e, href, router.push)} data-mention-status="ok">
      {ref.icon ? (
        <span className="leafdesk-mention-emoji" aria-hidden>
          {ref.icon}
        </span>
      ) : (
        <PageIcon icon={null} kind={ref.kind} className="leafdesk-mention-icon" />
      )}
      <span className="leafdesk-mention-label">{pageLabel(ref.title, tc("untitled"))}</span>
    </a>
  );
}

function PersonMentionChip({ name }: { name: string }) {
  return (
    <span className="leafdesk-mention leafdesk-mention-user">
      <CircleUser className="leafdesk-mention-icon" aria-hidden />
      <span className="leafdesk-mention-label">{name || "…"}</span>
    </span>
  );
}

const REMINDER_DAYS = [0, 1, 7] as const;
type ReminderChoice = (typeof REMINDER_DAYS)[number] | "none" | "custom";

/** Which of the offered reminders `remindAt` is for `date`, in this browser's time zone. */
function reminderChoice(date: string, remindAt: string): ReminderChoice {
  if (!remindAt) return "none";
  return REMINDER_DAYS.find((days) => localReminderAt(date, days) === new Date(remindAt).toISOString()) ?? "custom";
}

function DateMentionChip({ props, onChange }: { props: MentionProps; onChange: ((next: Partial<MentionProps>) => void) | null }) {
  const locale = useLocale();
  const t = useTranslations("page.mention");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const when = props.remindAt ? new Date(props.remindAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <>
      <span
        ref={anchor}
        className="leafdesk-mention leafdesk-mention-date"
        title={when ? t("reminderSet", { when }) : undefined}
        onClick={onChange ? () => setOpen((v) => !v) : undefined}
        style={onChange ? undefined : { cursor: "default" }}
      >
        <CalendarDays className="leafdesk-mention-icon" aria-hidden />
        <span className="leafdesk-mention-label">{formatIsoDate(props.date, locale)}</span>
        {props.remindAt && <Bell className="leafdesk-mention-icon" style={{ marginLeft: "0.25em", marginRight: 0 }} aria-label={t("reminder")} />}
      </span>
      {open && onChange && anchor.current && (
        <DatePopover anchor={anchor.current} props={props} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Changes a date mention and its reminder. It sits in a portal outside the editor, so typing in it
 * never reaches the document.
 */
function DatePopover({
  anchor,
  props,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  props: MentionProps;
  onChange: (next: Partial<MentionProps>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.mention");
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const choice = reminderChoice(props.date, props.remindAt);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const setDate = (date: string) => {
    if (!isIsoDate(date)) return;
    // A reminder "the day before" stays the day before the new date.
    const remindAt = typeof choice === "number" ? localReminderAt(date, choice) : props.remindAt;
    onChange({ date, remindAt });
  };
  const setReminder = (next: ReminderChoice) => {
    if (next === "custom") return;
    onChange({ remindAt: next === "none" ? "" : localReminderAt(props.date, next), id: props.id || newMentionId() });
  };
  const past = props.remindAt && new Date(props.remindAt).getTime() < Date.now();
  const label = (days: (typeof REMINDER_DAYS)[number]) =>
    days === 0 ? t("remindSameDay") : days === 1 ? t("remindDayBefore") : t("remindWeekBefore");

  if (!position) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("date")}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-50 w-72 rounded-lg border border-border bg-bg p-3 text-sm shadow-lg"
    >
      <label className="block text-xs text-fg-muted" htmlFor="mention-date">
        {t("date")}
      </label>
      <input
        id="mention-date"
        type="date"
        value={props.date}
        onChange={(e) => setDate(e.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-border bg-bg px-2 outline-none focus:border-accent"
      />
      <p className="mt-3 text-xs text-fg-muted">{t("reminder")}</p>
      <div className="mt-1 flex flex-col">
        {(["none", ...REMINDER_DAYS] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={choice === option}
            onClick={() => setReminder(option)}
            className={cn("flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover", choice === option && "bg-bg-active")}
          >
            {option === "none" ? t("remindNone") : label(option)}
          </button>
        ))}
      </div>
      {props.remindAt && (
        <p className={cn("mt-2 text-xs", past ? "text-danger" : "text-fg-muted")}>
          {past
            ? t("reminderPast")
            : `${t("reminderSet", { when: new Date(props.remindAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) })}. ${t("reminderHint")}`}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={onClose} className="rounded-md border border-border px-2.5 py-1 hover:bg-bg-hover">
          {t("done")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

const Mention = createReactInlineContentSpec(mentionConfig, {
  render: function MentionView({ inlineContent, updateInlineContent, editor }) {
    const props = mentionProps(inlineContent.props);
    const change = useCallback(
      (next: Partial<MentionProps>) => updateInlineContent({ type: "mention", props: { ...props, ...next } }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [updateInlineContent, JSON.stringify(props)],
    );
    if (props.kind === "page") return <PageMentionChip pageId={props.pageId} />;
    if (props.kind === "user") return <PersonMentionChip name={props.name} />;
    return <DateMentionChip props={props} onChange={editor.isEditable ? change : null} />;
  },
  // Copied out of the editor: plain text and links other apps understand, never a title the
  // browser doesn't already show.
  toExternalHTML: function MentionHTML({ inlineContent }) {
    const props = mentionProps(inlineContent.props);
    if (props.kind === "user") return <span>@{props.name}</span>;
    if (props.kind === "date") return <span>{props.date}</span>;
    const ref = refs.get(props.pageId);
    return ref?.status === "ok" ? <a href={pagePath(ref.workspaceId, ref.id)}>{ref.title}</a> : <span />;
  },
});

// ---------------------------------------------------------------------------------------------
// "Link to page" block

const PageLinkBlock = createReactBlockSpec(pageLinkBlockConfig, {
  render: function PageLinkView({ block }) {
    const t = useTranslations("page.mention");
    const tc = useTranslations("common");
    const router = useRouter();
    const ref = usePageRef(block.props.pageId);
    const row = "flex w-full items-center gap-2 rounded-md px-1 py-1";
    if (!block.props.pageId) return <div className="w-full" />;
    if (!ref || ref.status !== "ok") {
      const Icon = !ref ? Link2 : ref.status === "noAccess" ? Lock : FileX2;
      return (
        <div contentEditable={false} className={cn(row, "text-fg-faint")} data-mention-status={ref?.status ?? "loading"}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span>{!ref ? t("loading") : t(ref.status === "noAccess" ? "noAccess" : "deleted")}</span>
        </div>
      );
    }
    const href = pagePath(ref.workspaceId, ref.id);
    return (
      <div contentEditable={false} className="w-full">
        <a href={href} onClick={(e) => openPage(e, href, router.push)} className={cn(row, "hover:bg-bg-hover")} data-mention-status="ok">
          <PageIcon icon={ref.icon} kind={ref.kind} className="shrink-0 text-base" />
          <span className="truncate font-medium underline decoration-fg-faint underline-offset-2">{pageLabel(ref.title, tc("untitled"))}</span>
        </a>
      </div>
    );
  },
  toExternalHTML: function PageLinkHTML({ block }) {
    const ref = refs.get(block.props.pageId);
    return ref?.status === "ok" ? (
      <p>
        <a href={pagePath(ref.workspaceId, ref.id)}>{ref.title}</a>
      </p>
    ) : (
      <p />
    );
  },
});

export const mentionInlineSpecs = { mention: Mention };
export const mentionBlockSpecs = { pageLink: PageLinkBlock() };

/** The "Link to page" slash menu entry, with the basic blocks. */
export function usePageLinkSlashItem(editor: PageEditor, onPick: (at: string) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks.pageLink");
  return useMemo(
    () => [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.quote.group,
        icon: <Link2 size={18} />,
        onItemClick: () => onPick(editor.getTextCursorPosition().block.id),
      },
    ],
    [editor, t, onPick],
  );
}

// ---------------------------------------------------------------------------------------------
// The @ menu

type DateItem = { key: "today" | "tomorrow" | "yesterday" | "nextWeek"; days: number };
const DATE_ITEMS: DateItem[] = [
  { key: "today", days: 0 },
  { key: "tomorrow", days: 1 },
  { key: "yesterday", days: -1 },
  { key: "nextWeek", days: 7 },
];

/** `@` in the editor: people of the workspace, pages the user can see, and dates. */
export function MentionMenu({ editor, workspaceId, pageId }: { editor: PageEditor; workspaceId: string; pageId: string }) {
  const t = useTranslations("page.mention");
  const pageItem = usePageItem();
  const locale = useLocale();
  // The last answer, so typing doesn't flash an empty menu while the next one loads.
  const last = useRef<MentionCandidates>({ people: [], pages: [] });

  const insert = useCallback(
    (props: Partial<MentionProps>) => {
      editor.insertInlineContent([{ type: "mention", props: { ...props } }, " "] as never, { updateSelection: true });
    },
    [editor],
  );

  const getItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      let found = last.current;
      try {
        found = await mentionCandidatesAction(pageId, query);
        last.current = found;
      } catch {
        // Keep the last answer.
      }
      const q = searchFold(query.trim());
      const people = found.people.map(
        (p): DefaultReactSuggestionItem => ({
          title: p.name,
          group: t("people"),
          icon: p.image ? <UserAvatar name={p.name} image={p.image} size="xs" /> : <CircleUser size={18} />,
          onItemClick: () => insert({ kind: "user", id: newMentionId(), userId: p.id, name: p.name }),
        }),
      );
      const pages = found.pages.map((p) => pageItem(p, () => insertPageMention(editor, workspaceId, p)));
      const dates = DATE_ITEMS.flatMap((d): DefaultReactSuggestionItem[] => {
        const title = t(d.key);
        if (q && !searchFold(title).includes(q) && !searchFold(d.key).includes(q)) return [];
        const date = localIsoDate(d.days);
        return [
          {
            title,
            subtext: formatIsoDate(date, locale),
            group: t("dates"),
            icon: <CalendarDays size={18} />,
            onItemClick: () => insert({ kind: "date", id: newMentionId(), date }),
          },
        ];
      });
      if (isIsoDate(query.trim())) {
        const date = query.trim();
        dates.unshift({
          title: formatIsoDate(date, locale),
          subtext: date,
          group: t("dates"),
          icon: <CalendarDays size={18} />,
          onItemClick: () => insert({ kind: "date", id: newMentionId(), date }),
        });
      }
      return [...people, ...pages, ...dates];
    },
    [editor, workspaceId, pageId, insert, pageItem, t, locale],
  );

  return <SuggestionMenuController triggerCharacter="@" getItems={getItems} />;
}

type PageCandidate = MentionCandidates["pages"][number];

/** A mention of `p` at the cursor, its chip showing the title right away. */
function insertPageMention(editor: PageEditor, workspaceId: string, p: PageCandidate) {
  refs.set(p.id, { id: p.id, status: "ok", workspaceId, title: p.title, icon: p.icon, kind: p.kind });
  editor.insertInlineContent([{ type: "mention", props: { kind: "page", pageId: p.id } }, " "] as never, { updateSelection: true });
  void fetchRefs([p.id]);
}

/** A page in the @ and [[ menus. */
function usePageItem() {
  const t = useTranslations("page.mention");
  const tc = useTranslations("common");
  return useCallback(
    (p: PageCandidate, onItemClick: () => void): DefaultReactSuggestionItem => ({
      title: pageLabel(p.title, tc("untitled")),
      group: t("pages"),
      icon: <PageIcon icon={p.icon} kind={p.kind} className="text-base" />,
      onItemClick,
    }),
    [t, tc],
  );
}

// ---------------------------------------------------------------------------------------------
// The [[ menu

const PAGE_LINK_TRIGGER = "[[";

const sameTitle = (p: PageCandidate, title: string) => searchFold(p.title.trim()) === searchFold(title);

/**
 * `[[` in the editor: pages to link to, and a new page inside this one with the typed title.
 * Typing `[[Title]]` out links to the page of that title when there is one; when there isn't, the
 * text stays as typed.
 */
export function PageLinkMenu({ editor, workspaceId, pageId, offline }: { editor: PageEditor; workspaceId: string; pageId: string; offline: boolean }) {
  const t = useTranslations("page.mention");
  const pageItem = usePageItem();
  const suggestionMenu = useExtension(SuggestionMenu, { editor });
  // The last answer and what it was for: typing doesn't flash an empty menu while the next one
  // loads, and "]]" right after typing a title doesn't wait for it again. Pages created, renamed or
  // trashed since make it stale.
  const last = useRef<{ query: string; pages: PageCandidate[] } | null>(null);
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "tree") last.current = null;
  });

  const load = useCallback(
    async (query: string) => {
      if (last.current?.query === query) return last.current.pages;
      try {
        const { pages } = await mentionCandidatesAction(pageId, query);
        last.current = { query, pages };
        return pages;
      } catch {
        return last.current?.pages ?? [];
      }
    },
    [pageId],
  );

  const createAndLink = useCallback(
    async (title: string) => {
      try {
        const { id } = await createPageAction({ workspaceId, parentId: pageId, title });
        last.current = null;
        insertPageMention(editor, workspaceId, { id, title, icon: null, kind: "page" });
      } catch {
        // Not created (offline, or no longer allowed here): the title stays as text.
        editor.insertInlineContent(title, { updateSelection: true });
      }
    },
    [editor, workspaceId, pageId],
  );

  const getItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      // Past "]]" (handled below) there is nothing to offer, and the menu closes.
      if (query.includes("]]")) return [];
      const title = query.replace(/\]$/, "").trim();
      const pages = await load(title);
      const items = pages.map((p) => pageItem(p, () => insertPageMention(editor, workspaceId, p)));
      if (title && !offline && !pages.some((p) => sameTitle(p, title))) {
        items.push({
          title: t("newPage", { title }),
          subtext: t("newPageHint"),
          group: t("pages"),
          icon: <FilePlus size={18} />,
          onItemClick: () => void createAndLink(title),
        });
      }
      return items;
    },
    [editor, workspaceId, offline, load, pageItem, createAndLink, t],
  );

  // "[[Title]]" typed out: the page of that title, if there is one.
  const query = useExtensionState(SuggestionMenu, {
    editor,
    selector: (state) => (state?.show && state.triggerCharacter === PAGE_LINK_TRIGGER ? state.query : null),
  });
  useEffect(() => {
    if (query === null || !query.endsWith("]]")) return;
    const title = query.slice(0, -2).trim();
    let current = true;
    void (title ? load(title) : Promise.resolve([])).then((pages) => {
      if (!current) return;
      const match = pages.find((p) => sameTitle(p, title));
      suggestionMenu.closeMenu();
      if (!match) return;
      suggestionMenu.clearQuery();
      insertPageMention(editor, workspaceId, match);
    });
    return () => {
      current = false;
    };
  }, [query, load, suggestionMenu, editor, workspaceId]);

  usePastedWikilinks(editor, workspaceId, pageId);

  return <SuggestionMenuController triggerCharacter={PAGE_LINK_TRIGGER} getItems={getItems} />;
}

type EditorBlock = PageEditor["document"][number];

/** Blocks of the document in order, nested ones after their parent. */
function flatBlocks(blocks: EditorBlock[], out: EditorBlock[] = []): EditorBlock[] {
  for (const block of blocks) {
    out.push(block);
    flatBlocks(block.children as EditorBlock[], out);
  }
  return out;
}

/**
 * Text pasted into the page: each `[[Title]]` in it naming a page becomes a mention of that page,
 * as when it is typed (lib/wikilinks). The paste lands as usual; the pasted blocks (from where the
 * cursor was to where it ends up) are linked once the titles are looked up, each read again then so
 * that typing meanwhile isn't lost.
 */
function usePastedWikilinks(editor: PageEditor, workspaceId: string, pageId: string) {
  useEffect(() => {
    // The editor may be gone by the time the paste has landed or the titles are looked up.
    let live = true;
    const onPaste = (event: ClipboardEvent) => {
      const root = editor.domElement;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      if (!/\[\[[^[\]\n]+\]\]/.test(event.clipboardData?.getData("text/plain") ?? "")) return;
      const from = editor.getTextCursorPosition().block.id;
      setTimeout(() => {
        if (!live) return;
        const to = editor.getTextCursorPosition().block.id;
        const all = flatBlocks(editor.document);
        const start = all.findIndex((b) => b.id === from);
        const end = all.findIndex((b) => b.id === to);
        const pasted = end === -1 ? [] : all.slice(start === -1 || start > end ? end : start, end + 1);
        const ids = pasted.map((b) => b.id);
        const titles = wikilinkTitles(pasted.map((b) => ({ ...b, children: [] })));
        if (!titles.length) return;
        void pagesNamedAction(pageId, titles)
          .then((found) => {
            const pages = new Map(found);
            if (!live || !pages.size) return;
            for (const id of ids) {
              const block = editor.getBlock(id);
              if (!block) continue;
              const copy = { type: block.type, content: structuredClone(block.content) };
              if (!linkWikilinks([copy], (title) => pages.get(titleKey(title))?.id)) continue;
              editor.updateBlock(id, { content: copy.content } as never);
            }
            for (const p of pages.values()) refs.set(p.id, { id: p.id, status: "ok", workspaceId, title: p.title, icon: p.icon, kind: p.kind });
            void fetchRefs([...pages.values()].map((p) => p.id));
          })
          .catch(() => {
            // Not looked up (offline): the titles stay as text.
          });
      });
    };
    document.addEventListener("paste", onPaste, true);
    return () => {
      live = false;
      document.removeEventListener("paste", onPaste, true);
    };
  }, [editor, workspaceId, pageId]);
}

// ---------------------------------------------------------------------------------------------
// Picking a page

/** Picks the page a "Link to page" block points at: pages of the workspace the user can see. */
export function PagePicker({
  open,
  pageId,
  onPick,
  onClose,
}: {
  open: boolean;
  pageId: string;
  onPick: (pageId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.pageLinkPicker");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<MentionCandidates["pages"] | null>(null);
  const [failed, setFailed] = useState(false);
  // The highlighted result, picked with Enter; arrows move it.
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    const timer = setTimeout(() => {
      mentionCandidatesAction(pageId, query)
        .then((found) => {
          if (!current) return;
          setPages(found.pages);
          setActive(0);
        })
        .catch(() => current && setFailed(true));
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, pageId, query]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setPages(null);
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-fg-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!pages?.length) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + step + pages.length) % pages.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const picked = pages[Math.min(active, pages.length - 1)];
              if (picked) onPick(picked.id);
            }
          }}
          placeholder={t("search")}
          aria-label={t("title")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className={cn("max-h-80 overflow-y-auto p-1", !pages && !failed && "opacity-70")}>
        {pages?.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            onMouseEnter={() => setActive(i)}
            aria-current={i === active || undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover",
              i === active && "bg-bg-hover",
            )}
          >
            <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
            <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
          </button>
        ))}
        {failed && (
          <p role="alert" className="px-2 py-3 text-sm text-danger">
            {t("failed")}
          </p>
        )}
        {!pages && !failed && <p className="px-2 py-3 text-sm text-fg-muted">{tc("loading")}</p>}
        {pages && !pages.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("empty")}</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Backlinks

/**
 * "Linked from": the pages whose body mentions or links to this one, as far as the viewer can see,
 * each with the text around its link; and below, folded away, the pages that write this page's
 * title without linking to it, which someone who may edit them can link from here.
 */
export function Backlinks({ workspaceId, pageId, title, canLink }: { workspaceId: string; pageId: string; title: string; canLink: boolean }) {
  const t = useTranslations("page.backlinks");
  const tc = useTranslations("common");
  const router = useRouter();
  const [links, setLinks] = useState<Awaited<ReturnType<typeof backlinksAction>>>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedMention[]>([]);
  const [showUnlinked, setShowUnlinked] = useState(false);
  // The page being linked, and why the last one couldn't be.
  const [linking, setLinking] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; locked: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  // The unlinked list is a full-text search: loaded with the page, and again (with which ones can be
  // linked) once unfolded; while folded, changes elsewhere don't load it again.
  const [unlinkedVersion, setUnlinkedVersion] = useState(0);
  const [checked, setChecked] = useState(false);
  const unfolded = useRef(false);
  unfolded.current = showUnlinked;

  useEffect(() => {
    let current = true;
    backlinksAction(pageId).then(
      (list) => current && setLinks(list),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [pageId, version]);
  useEffect(() => {
    let current = true;
    unlinkedMentionsAction(pageId, checked).then(
      (list) => current && setUnlinked(list),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [pageId, unlinkedVersion, checked]);
  // Renames and the trash change the lists; so does opening the page again after linking to it.
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event !== "tree") return;
    setVersion((v) => v + 1);
    if (unfolded.current) setUnlinkedVersion((v) => v + 1);
  });

  async function link(sourceId: string) {
    setLinking(sourceId);
    setFailed(null);
    try {
      const result = await linkMentionAction(sourceId, pageId);
      if (result.ok) setUnlinked((list) => list.filter((m) => m.id !== sourceId));
      else setFailed({ id: sourceId, locked: Boolean(result.locked) });
    } catch {
      setFailed({ id: sourceId, locked: false });
    } finally {
      setLinking(null);
      setVersion((v) => v + 1);
      setUnlinkedVersion((v) => v + 1);
    }
  }

  if (!links.length && !unlinked.length) return null;
  const name = pageLabel(title, tc("untitled"));
  const row = "-mx-1 flex items-center gap-2 rounded px-1 py-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg";
  return (
    <section aria-label={t("title")} className="mt-10 border-t border-border px-4 pt-4 md:px-[54px]">
      {links.length > 0 && (
        <>
          <h2 className="text-xs font-medium text-fg-muted" title={t("count", { count: links.length })}>
            {t("title")}
          </h2>
          <ul className="mt-1.5 flex flex-col">
            {links.map((link) => {
              const href = pagePath(link.workspaceId, link.id);
              return (
                <li key={link.id}>
                  <a href={href} onClick={(e) => openPage(e, href, router.push)} className={row}>
                    <PageIcon icon={link.icon} kind={link.kind} className="text-sm" />
                    <span className="truncate">{pageLabel(link.title, tc("untitled"))}</span>
                  </a>
                  {link.context && (
                    <p className="mb-1 line-clamp-2 pl-6 text-xs text-fg-faint">
                      {link.context.split(LINK_PLACEHOLDER).map((part, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="font-medium text-fg-muted">{name}</span>}
                          {part}
                        </Fragment>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {unlinked.length > 0 && (
        <div className={cn(links.length > 0 && "mt-3")}>
          <button
            type="button"
            aria-expanded={showUnlinked}
            onClick={() => {
              setShowUnlinked((v) => !v);
              setChecked(true);
            }}
            title={t("unlinkedHint")}
            className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showUnlinked && "rotate-90")} />
            {t("unlinked", { count: unlinked.length })}
          </button>
          {showUnlinked && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {unlinked.map((mention) => {
                const href = pagePath(mention.workspaceId, mention.id);
                const label = pageLabel(mention.title, tc("untitled"));
                return (
                  <li key={mention.id}>
                    <div className="flex items-center gap-2">
                      <a href={href} onClick={(e) => openPage(e, href, router.push)} className={cn(row, "min-w-0 flex-1")}>
                        <PageIcon icon={mention.icon} kind={mention.kind} className="text-sm" />
                        <span className="truncate">{label}</span>
                      </a>
                      {canLink && mention.linkable && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={linking !== null}
                          onClick={() => void link(mention.id)}
                          aria-label={t("linkLabel", { title: label })}
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {t("link")}
                        </Button>
                      )}
                    </div>
                    <p className="line-clamp-2 pl-6 text-xs text-fg-faint">
                      {mention.excerpt.before}
                      <span className="font-medium text-fg-muted">{mention.excerpt.match}</span>
                      {mention.excerpt.after}
                    </p>
                    {failed?.id === mention.id && (
                      <p role="status" className="pl-6 text-xs text-danger">
                        {failed.locked ? t("locked") : t("linkFailed")}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
