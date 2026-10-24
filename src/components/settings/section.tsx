import type { ReactNode } from "react";
import { settingAnchor } from "@/lib/settings-search";

// Used from server and client components alike, so it cannot pull `cn` from the client-only ui module.
const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/** Title and optional lead text at the top of a settings tab. */
export function SettingsHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-2 text-sm text-fg-muted">{description}</p>}
    </header>
  );
}

/** A titled block of settings; rows inside are drawn as one card with dividers. */
export function SettingsGroup({
  anchor,
  title,
  description,
  action,
  children,
  bare,
  className,
}: {
  /** The setting's id in lib/settings-search.ts, which the settings search jumps to. */
  anchor?: string;
  title?: string;
  description?: ReactNode;
  /** Controls shown to the right of the title. */
  action?: ReactNode;
  children: ReactNode;
  /** Render children as they are, without the card around them. */
  bare?: boolean;
  className?: string;
}) {
  return (
    <section id={anchor && settingAnchor(anchor)} className={cn("space-y-3", className)}>
      {(title || action) && (
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {bare ? (
        children
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-subtle/60">{children}</div>
      )}
    </section>
  );
}

/** One setting: label and help on the left, its control on the right, optional full-width content below. */
export function SettingsRow({
  anchor,
  title,
  description,
  htmlFor,
  control,
  children,
  className,
}: {
  /** The setting's id in lib/settings-search.ts, which the settings search jumps to. */
  anchor?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Id of the control, so the title works as its label. */
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Title = htmlFor ? "label" : "div";
  return (
    <div id={anchor && settingAnchor(anchor)} className={cn("px-5 py-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <Title htmlFor={htmlFor} className="block text-sm font-medium">
            {title}
          </Title>
          {description && <div className="mt-1 text-sm text-fg-muted">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
