"use client";

import { X } from "lucide-react";
import { createContext, forwardRef, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { pointBox } from "@/lib/placement";
import { IconGlyph } from "./builtin-icon";
import { usePlacement } from "./use-placement";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  // A faint light along the top edge and a soft drop shadow lift both off the page.
  primary: "bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.12)] hover:opacity-90",
  secondary: "border border-border bg-bg shadow-[0_1px_2px_rgb(0_0_0/0.05)] hover:bg-bg-hover",
  ghost: "hover:bg-bg-hover text-fg-muted hover:text-fg",
  danger: "bg-danger text-white hover:opacity-90",
};

/** A Button's classes, for a link that looks like one. */
export function buttonClass({ variant = "secondary", size = "md" }: { variant?: ButtonVariant; size?: "sm" | "md" } = {}) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
    buttonStyles[variant],
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }
>(function Button({ variant, size, className, type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />;
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function IconButton({ label, className, type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-active hover:text-fg",
          className,
        )}
        {...props}
      />
    );
  },
);

/** A form's select (add "w-full" to fill the line). */
export const selectClass =
  "h-8 rounded-md border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60";

export const textareaClass =
  "w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent";

/** A small field in a menu (a property's settings). */
export const menuFieldClass =
  "block w-full h-7 rounded-md border border-border bg-bg px-1.5 text-sm text-fg outline-none focus:border-accent";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-md border border-border bg-bg px-2.5 text-sm outline-none placeholder:text-fg-faint focus:border-accent",
        className,
      )}
      {...props}
    />
  );
});

/** Closes when clicking outside or pressing Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Handled here: whatever else listens for Escape (a panel around it) stays open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

/** Anchored popover menu. `trigger` receives the toggle handler. */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
  wrapperClassName,
  open: controlledOpen,
  onOpenChange,
  at,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  /** Opens below the trigger, or above it (near the bottom of the screen). */
  side?: "bottom" | "top";
  className?: string;
  /** Classes for the element around the trigger (it is `relative inline-flex` by default). */
  wrapperClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Opens at this point of the window instead (a right click), or from this element with `align`
   * (a button in a list that would cut the menu off): placed by `usePlacement`, inside the window.
   */
  at?: { x: number; y: number } | Element | null;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setUncontrolled(v));
  const close = () => setOpen(false);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const panel = useRef<HTMLDivElement>(null);
  // `at` is only ever set in the browser, where Element exists.
  const fromElement = !!at && at instanceof Element;
  const anchor = useMemo(() => (!at ? null : at instanceof Element ? at : pointBox(at.x, at.y)), [at]);
  const placed = usePlacement(panel, anchor, open && !!anchor, { align: fromElement ? align : "start", gap: fromElement ? 4 : 0 });
  return (
    // data-open lets hover-only toolbars stay shown while their menu is open (`has-[[data-open]]:flex`).
    <div ref={ref} data-open={open || undefined} className={cn("relative inline-flex", wrapperClassName)}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          ref={panel}
          style={at ? placed : undefined}
          className={cn(
            "z-50 min-w-48 rounded-lg border border-border bg-bg p-1 shadow-lg",
            at ? "fixed" : "absolute",
            !at && (side === "top" ? "bottom-full mb-1" : "top-full mt-1"),
            !at && (align === "end" ? "inset-e-0" : "inset-s-0"),
            className,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  active,
  disabled,
  title,
  trailing,
  pressed,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
  /** Shown at the end of the line: a submenu's arrow, a tick. */
  trailing?: ReactNode;
  /** An item that switches something on and off: whether it is on. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
        danger && "text-danger",
        active && "bg-bg-hover",
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-fg-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {trailing && <span className="flex shrink-0 items-center text-fg-muted">{trailing}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

/**
 * The shadow under a dialog's panel: a hairline ring and two layered shadows, a tight one under the
 * edge and a wide, soft one. For panels shown over a shade without `Dialog` too (history, AI review).
 */
export const dialogShadow =
  "shadow-[0_0_0_1px_rgb(0_0_0/0.03),0_2px_6px_-2px_rgb(0_0_0/0.08),0_24px_56px_-16px_rgb(0_0_0/0.28)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.03),0_2px_6px_-2px_rgb(0_0_0/0.4),0_24px_56px_-16px_rgb(0_0_0/0.6)]";

export function Dialog({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useDismiss<HTMLDivElement>(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <DialogTitleId.Provider value={titleId}>
    <div data-window-shade className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[12vh]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        // Named by its DialogTitle or DialogHeader, when it has one.
        aria-labelledby={titleId}
        data-dialog
        className={cn(
          "w-full rounded-xl border border-border bg-bg",
          dialogShadow,
          // cn doesn't merge classes: with two max-w utilities the stylesheet's order would pick, not the caller.
          !className?.split(" ").some((c) => c.startsWith("max-w-")) && "max-w-xl",
          !className?.split(" ").some((c) => c.startsWith("overflow-")) && "overflow-hidden",
          className,
        )}
      >
        {children}
      </div>
    </div>
    </DialogTitleId.Provider>
  );
}

/** The id a dialog is labelled by, given to its title. */
const DialogTitleId = createContext<string | undefined>(undefined);

/** A dialog's title, for a dialog without a DialogHeader (a short confirmation at the top of its DialogBody). */
export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 id={useContext(DialogTitleId)} className={cn("text-base leading-6 font-semibold text-fg", className)}>
      {children}
    </h2>
  );
}

/**
 * A dialog's top bar: an optional icon, the title with a line under it, actions of its own and the
 * close button (with `onClose`). Dialogs that only ask one thing put a DialogTitle in their body instead.
 */
export function DialogHeader({
  title,
  description,
  icon,
  actions,
  onClose,
  closeLabel,
  closeDisabled,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  /** The close button's name (`common.close`); needed with `onClose`. */
  closeLabel?: string;
  closeDisabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 items-start gap-3 border-b border-border px-5 py-4", className)}>
      {icon && (
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle text-fg-muted">
          {icon}
        </span>
      )}
      <div className={cn("min-w-0 flex-1", Boolean(icon) && !description && "self-center")}>
        <DialogTitle>{title}</DialogTitle>
        {description && <div className="mt-0.5 text-sm text-fg-muted">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      {onClose && (
        <IconButton label={closeLabel ?? ""} onClick={onClose} disabled={closeDisabled} className="-me-1.5 -mt-0.5 h-7 w-7 text-fg-faint">
          <X className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  );
}

/** A dialog's content between its header and footer. Pass `max-h-[…] overflow-y-auto` to scroll it. */
export function DialogBody({ children, className, ...props }: { children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div className={cn(...bodyDefaults(className), className)} {...props}>
      {children}
    </div>
  );
}

/**
 * DialogBody's spacing, less what `className` sets itself: cn doesn't merge classes, and with two
 * utilities for the same thing the stylesheet's order would pick, not the caller.
 */
function bodyDefaults(className: string | undefined) {
  const own = className?.split(" ") ?? [];
  const sets = (...prefixes: string[]) => own.some((c) => prefixes.some((prefix) => c.startsWith(prefix)));
  return [
    !sets("space-y-") && "space-y-4",
    !sets("p-", "px-", "ps-", "pe-") && "px-5",
    !sets("p-", "py-") && (sets("pt-") ? "pb-4" : sets("pb-") ? "pt-4" : "py-4"),
  ];
}

/** A dialog's bottom bar of buttons, the main one last: Cancel `secondary`, the action `primary` or `danger`. */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-subtle px-5 py-3", className)}>
      {children}
    </div>
  );
}

/** On/off control. `label` is for screen readers when there is no visible label next to it. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-md border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border bg-bg-active",
      )}
    >
      <span
        className={cn(
          "h-3.5 w-3.5 rounded-[3px] bg-white shadow-sm transition-transform",
          checked ? "translate-x-[18px] rtl:-translate-x-[18px]" : "translate-x-[2px] rtl:-translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function PageIcon({ icon, kind, className }: { icon: string | null; kind?: string; className?: string }) {
  if (icon) return <IconGlyph icon={icon} className={className} />;
  return (
    <svg viewBox="0 0 16 16" className={cn("h-4 w-4 text-fg-faint", className)} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      {kind === "database" ? (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          <path d="M2.5 6.5h11M6.5 6.5v7" />
        </>
      ) : (
        <>
          <path d="M4 2.5h5.5L12 5v8.5H4z" />
          <path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" />
        </>
      )}
    </svg>
  );
}

export { pageLabel } from "@/lib/labels";
