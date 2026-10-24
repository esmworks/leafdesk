"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

/**
 * Short notes at the bottom of the window after something that can be undone or followed: moving
 * a page (with a link to where it went), moving pages or rows to the trash. Any client code shows
 * one with `showToast`; the workspace layout renders them (`Toaster`). One at a time: a new note
 * replaces the one showing, so an undo always undoes the latest action.
 */
export type Toast = {
  message: string;
  /** A link after the message, to where the thing went. */
  link?: { label: string; href: string };
  /** "Undo": runs once, then the note closes. */
  undo?: () => void | Promise<void>;
};

const SHOWN_MS = 6_000;

type Shown = Toast & { id: number };
let current: Shown | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(toast: Toast) {
  current = { ...toast, id: nextId++ };
  emit();
}

/** The note showing now, if any (tests). */
export const currentToast = () => current;

export function dismissToast(id?: number) {
  if (!current || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function Toaster() {
  const t = useTranslations("common.toast");
  const toast = useSyncExternalStore(subscribe, () => current, () => null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismissToast(toast.id), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4" role="status" aria-live="polite">
      {toast && (
        <div
          key={toast.id}
          className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2 text-sm shadow-lg"
        >
          <span className="min-w-0 truncate">
            {toast.message}
            {toast.link && (
              <>
                {" "}
                <Link href={toast.link.href} className="font-medium underline underline-offset-2" onClick={() => dismissToast(toast.id)}>
                  {toast.link.label}
                </Link>
              </>
            )}
          </span>
          {toast.undo && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-bg-hover"
              onClick={() => {
                const undo = toast.undo!;
                dismissToast(toast.id);
                void undo();
              }}
            >
              {t("undo")}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
            aria-label={t("dismiss")}
            onClick={() => dismissToast(toast.id)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
