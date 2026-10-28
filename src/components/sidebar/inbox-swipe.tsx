"use client";

import { AlarmClock, Check, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { swipeActionFor, swipeAxis, swipeOffset, swipeSide, type SwipeAction } from "@/lib/inbox-swipe";

/**
 * An inbox item that a finger can swipe (lib/inbox-swipe.ts): toward the end of the line marks it
 * read or unread, toward its start snoozes it until tomorrow morning. What letting go would do
 * shows behind the item. Only touch swipes: a mouse or a pen clicks and selects as before, and the
 * item's buttons stay for everyone.
 */
export function InboxSwipe({
  read,
  snoozable,
  onRead,
  onSnooze,
  children,
}: {
  /** Whether the item (or every item of a group) is read: the swipe marks it the other way. */
  read: boolean;
  snoozable: boolean;
  onRead: () => void;
  onSnooze: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("sidebar.inbox");
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Whether the line runs right to left, read from the item when a swipe starts.
  const [rtl, setRtl] = useState(false);
  const start = useRef<{ x: number; y: number; axis: "x" | "y" | null; rtl: boolean } | null>(null);
  // A swipe ends where it began a tap: the click it may make must not open the item.
  const swiped = useRef(false);

  const reset = () => {
    start.current = null;
    setDragging(false);
    setDx(0);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    start.current = { x: event.clientX, y: event.clientY, axis: null, rtl: getComputedStyle(event.currentTarget).direction === "rtl" };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = start.current;
    if (!at || event.pointerType !== "touch") return;
    const moved = event.clientX - at.x;
    if (at.axis === null) {
      at.axis = swipeAxis(moved, event.clientY - at.y);
      if (at.axis === "y") {
        start.current = null;
        return;
      }
      if (at.axis === "x") {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        setRtl(at.rtl);
      }
    }
    if (at.axis === "x") setDx(swipeOffset(moved, at.rtl, snoozable));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const at = start.current;
    if (!at || at.axis !== "x") {
      start.current = null;
      return;
    }
    swiped.current = true;
    const action = swipeActionFor(event.clientX - at.x, at.rtl, snoozable);
    reset();
    if (action === "read") onRead();
    else if (action === "snooze") onSnooze();
  };

  const side: SwipeAction | null = dx === 0 ? null : swipeSide(dx, rtl, snoozable);
  const armed = side !== null && swipeActionFor(dx, rtl, snoozable) === side;

  return (
    <div className="relative overflow-hidden rounded-md">
      {side && (
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center gap-1.5 rounded-md px-4 text-xs font-medium transition-colors",
            side === "read" ? "justify-start" : "justify-end",
            armed ? "bg-accent text-accent-fg" : "bg-bg-active text-fg-muted",
          )}
        >
          {side === "read" ? (
            <>
              {read ? <Mail className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {read ? t("markUnread") : t("groupMarkRead")}
            </>
          ) : (
            <>
              <AlarmClock className="h-4 w-4" />
              {t("snoozeChoice.tomorrow")}
            </>
          )}
        </div>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onClickCapture={(event) => {
          if (!swiped.current) return;
          swiped.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        // pan-y: the list still scrolls under a finger, and a sideways move comes here.
        // group/row: the inbox row's actions show while it is hovered or focused (inbox-dialog.tsx).
        className={cn("group/row relative touch-pan-y bg-bg", !dragging && "motion-safe:transition-transform motion-safe:duration-150")}
      >
        {children}
      </div>
    </div>
  );
}
