"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { getPageSiblingsAction } from "@/app/actions/pages";
import { cn, MenuSeparator, PageIcon, pageLabel, Popover } from "@/components/ui";
import type { PageSiblings } from "@/server/page-siblings";

/** How long the pointer rests on a crumb before its list opens, and how long the list waits to close. */
const OPEN_DELAY = 400;
const CLOSE_DELAY = 250;
/** How long a list once loaded is shown again without asking the server. */
const CACHE_FOR = 30_000;

const cache = new Map<string, { at: number; siblings: Promise<PageSiblings> }>();

function siblingsOf(pageId: string) {
  const hit = cache.get(pageId);
  if (hit && Date.now() - hit.at < CACHE_FOR) return hit.siblings;
  const siblings = getPageSiblingsAction(pageId);
  cache.set(pageId, { at: Date.now(), siblings });
  siblings.catch(() => cache.delete(pageId));
  return siblings;
}

/** The crumb whose list is open (its close function, kept current): only one shows at a time. */
let openCrumb: { current: () => void } | null = null;

/** What the crumb needs to open its list from the keyboard, and to say that it has one. */
export type CrumbTrigger = {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** Opens or closes the list (the current page's crumb, which goes nowhere itself). */
  toggle: () => void;
  /** Closes the list (a crumb that is a link, as it is followed). */
  close: () => void;
};

/**
 * A crumb of a page's breadcrumb with the list of the pages beside its page (the other subpages of
 * its parent, rows of its database, or top-level pages of its sidebar section), for jumping
 * sideways. It opens when the pointer rests on the crumb, or with the down arrow on it, and loads
 * the first time it opens.
 */
export function CrumbSiblings({
  workspaceId,
  pageId,
  title,
  children,
}: {
  workspaceId: string;
  pageId: string;
  /** The crumb's title as shown, naming the list for screen readers. */
  title: string;
  children: (trigger: CrumbTrigger) => ReactNode;
}) {
  const t = useTranslations("page.siblings");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [siblings, setSiblings] = useState<PageSiblings | null>(null);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Opened from the keyboard: the first item to focus once the list is there.
  const focusOnLoad = useRef(false);
  const closeRef = useRef<() => void>(() => {});

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => {
    clearTimer();
    if (openCrumb === closeRef) openCrumb = null;
  }, []);

  function close() {
    clearTimer();
    focusOnLoad.current = false;
    setOpen(false);
    if (openCrumb === closeRef) openCrumb = null;
  }
  closeRef.current = close;

  function show(focus = false) {
    clearTimer();
    focusOnLoad.current = focus;
    if (openCrumb && openCrumb !== closeRef) openCrumb.current();
    openCrumb = closeRef;
    setOpen(true);
    setFailed(false);
    siblingsOf(pageId).then(
      (loaded) => setSiblings(loaded),
      () => setFailed(true),
    );
  }

  // Once the list is there: focus goes into it when it was opened from the keyboard.
  useEffect(() => {
    if (open && siblings && focusOnLoad.current) focusItem("start");
  });

  function items() {
    return [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  }

  /** Focuses the current page's item (or the first) for "start", else the next or previous one. */
  function focusItem(to: "start" | "first" | "last" | 1 | -1) {
    const list = items();
    if (!list.length) return;
    focusOnLoad.current = false;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next =
      to === "start"
        ? Math.max(0, list.findIndex((el) => el.getAttribute("aria-current") === "page"))
        : to === "first"
          ? 0
          : to === "last"
            ? list.length - 1
            : (at + to + list.length) % list.length;
    list[next].focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (open && siblings) focusItem("start");
    else show(true);
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, "first" | "last" | 1 | -1> = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
    const move = moves[e.key];
    if (move === undefined) return;
    e.preventDefault();
    focusItem(move);
  }

  // Escape or a click elsewhere (Popover): focus goes back to the crumb when it was in the list.
  function onOpenChange(next: boolean) {
    if (next) return show();
    const inList = menuRef.current?.contains(document.activeElement);
    close();
    if (inList) rootRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }

  const trigger: CrumbTrigger = {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onKeyDown: onTriggerKeyDown,
    toggle: () => (open ? close() : show()),
    close,
  };

  const item = (p: { id: string; title: string; icon: string | null; kind: string }, label?: string) => (
    <Link
      key={p.id}
      href={`/w/${workspaceId}/p/${p.id}`}
      prefetch={false}
      role="menuitem"
      tabIndex={-1}
      aria-current={!label && p.id === pageId ? "page" : undefined}
      onClick={close}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm outline-none hover:bg-bg-hover focus-visible:bg-bg-hover",
        !label && p.id === pageId && "bg-bg-active font-medium",
      )}
    >
      <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
      <span className="truncate">{label ?? pageLabel(p.title, tc("untitled"))}</span>
    </Link>
  );

  return (
    <span
      ref={rootRef}
      className="flex min-w-0"
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        clearTimer();
        // Moving along the breadcrumb with a list open shows the next one at once.
        if (open) return;
        if (openCrumb) show();
        else timer.current = setTimeout(() => show(), OPEN_DELAY);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        clearTimer();
        if (open && !menuRef.current?.contains(document.activeElement)) timer.current = setTimeout(close, CLOSE_DELAY);
      }}
      onBlur={(e) => {
        // Tabbing out of the list closes it.
        if (open && menuRef.current?.contains(e.target) && !rootRef.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        wrapperClassName="min-w-0"
        className="max-h-80 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto text-fg"
        trigger={() => children(trigger)}
      >
        <div ref={menuRef} role="menu" aria-label={t("label", { title })} onKeyDown={onMenuKeyDown}>
          {siblings?.pages.map((p) => item(p))}
          {siblings && !siblings.pages.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("empty")}</p>}
          {siblings?.database && (
            <>
              {siblings.pages.length > 0 && <MenuSeparator />}
              {item(siblings.database, siblings.more ? t("allRows") : t("openDatabase"))}
            </>
          )}
          {!siblings && !failed && <p className="px-2 py-1.5 text-sm text-fg-muted">{tc("loading")}</p>}
          {failed && (
            <p role="alert" className="px-2 py-1.5 text-sm text-danger">
              {t("failed")}
            </p>
          )}
        </div>
      </Popover>
    </span>
  );
}
