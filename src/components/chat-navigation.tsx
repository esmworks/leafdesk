"use client";

/*
 * Finding one's way in a long chat (the AI chat, an agent's page): a line per question at the
 * column's side, which shows the question and the start of its answer on hover and brings it into
 * view on a click, and a button over the box that goes back to the latest once the person has
 * scrolled up. Both follow the chat's scrolling box, whichever it is (the AI chat's list, the
 * agent's page's window); the questions carry `data-turn` with their id. Loaded lazily, where a
 * chat has something to show.
 */
import { ArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/ui";

/** A question (`id` as its `data-turn`) and its answer, as written: the preview tidies them. */
export type Turn = { id: string; question: string; answer: string };

/** Questions a chat has before its lines show: a short chat needs none. */
const MIN_TURNS = 3;
/** A question counts as the one read once it is above this share of the box's height. */
const READING_LINE = 0.35;
/** Room left above a question brought into view. */
const TOP_ROOM = 24;
/** How far from the end the person has to scroll before the button shows. */
const AWAY = 240;

function topIn(scroller: HTMLElement, id: string): number | null {
  const el = scroller.querySelector<HTMLElement>(`[data-turn="${CSS.escape(id)}"]`);
  if (!el) return null;
  const box = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  return el.getBoundingClientRect().top - box + scroller.scrollTop;
}

/** Calls `update` as the box scrolls, resizes or its content grows. */
function useFollow(scroller: HTMLElement | null, update: () => void) {
  useEffect(() => {
    if (!scroller) return;
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scroller, update]);
}

/** A line per question, at the side of the chat; nothing while the chat is short or fits. */
export function TurnLines({ scroller, turns }: { scroller: HTMLElement | null; turns: Turn[] }) {
  const t = useTranslations("common.chatNav");
  const [shown, setShown] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const update = useCallback(() => {
    if (!scroller) return;
    setShown(turns.length >= MIN_TURNS && scroller.scrollHeight > scroller.clientHeight + 40);
    const line = scroller.scrollTop + scroller.clientHeight * READING_LINE;
    let current = turns[0]?.id ?? null;
    for (const turn of turns) {
      const top = topIn(scroller, turn.id);
      if (top !== null && top <= line) current = turn.id;
    }
    setReading(current);
  }, [scroller, turns]);
  useFollow(scroller, update);

  if (!shown || !scroller) return null;
  const go = (id: string) => {
    const top = topIn(scroller, id);
    if (top !== null) scroller.scrollTo({ top: Math.max(0, top - TOP_ROOM), behavior: "smooth" });
  };
  const hovered = hover === null ? null : turns[hover];
  // The line under the pointer at full length, its neighbours a little shorter.
  const look = (i: number, current: boolean) => {
    if (hover === null) return { scale: 1, strong: current, opacity: current ? 0.95 : 0.55 };
    const distance = Math.abs(i - hover);
    if (distance === 0) return { scale: 2.4, strong: true, opacity: 1 };
    if (distance === 1) return { scale: 1.7, strong: false, opacity: 0.85 };
    if (distance === 2) return { scale: 1.25, strong: false, opacity: 0.7 };
    return { scale: 1, strong: false, opacity: 0.55 };
  };

  return (
    <nav aria-label={t("label")} className="relative flex flex-col" onMouseLeave={() => setHover(null)}>
      {turns.map((turn, i) => {
        const v = look(i, turn.id === reading);
        return (
          <button
            key={turn.id}
            type="button"
            aria-label={t("question", { n: i + 1 })}
            aria-current={turn.id === reading ? "location" : undefined}
            onClick={() => go(turn.id)}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="flex h-2.5 w-6 items-center outline-none"
          >
            <span
              style={{ transform: `scaleX(${v.scale})`, opacity: v.opacity }}
              className={cn("block h-0.5 w-2.5 origin-left rounded-full transition-[transform,opacity] duration-150 rtl:origin-right", v.strong ? "bg-fg" : "bg-fg-muted")}
            />
          </button>
        );
      })}
      {hovered && (
        <div
          aria-hidden
          className="pointer-events-none absolute start-8 z-20 w-80 space-y-1.5 rounded-lg border border-border bg-bg px-3 py-2 text-xs leading-5 shadow-lg"
          style={{ top: (hover ?? 0) * 10 - 8 }}
        >
          <p className="line-clamp-2 font-medium">{previewText(hovered.question)}</p>
          {hovered.answer && <p className="line-clamp-3 text-fg-muted">{previewText(hovered.answer)}</p>}
        </div>
      )}
    </nav>
  );
}

/** A round button back to the latest, while the person is reading further up. */
export function ToLatest({ scroller, className }: { scroller: HTMLElement | null; className?: string }) {
  const t = useTranslations("common.chatNav");
  const [away, setAway] = useState(false);
  const update = useCallback(() => {
    if (scroller) setAway(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > AWAY);
  }, [scroller]);
  useFollow(scroller, update);
  if (!away || !scroller) return null;
  return (
    <button
      type="button"
      aria-label={t("toLatest")}
      title={t("toLatest")}
      onClick={() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg text-fg-muted shadow-sm transition-colors hover:bg-bg-hover hover:text-fg",
        className,
      )}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}

/** A chat's text as a line of a preview: no Markdown marks, no citations. */
function previewText(text: string) {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The scrolling box a chat sits in: its own list, or the page's. */
export function scrollingBox(el: HTMLElement | null): HTMLElement | null {
  for (let at = el?.parentElement ?? null; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}
