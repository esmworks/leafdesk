"use client";

import { useTranslations } from "next-intl";
import { cn, Popover } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { splitViewers, textOn, userColor, type Presence } from "@/lib/presence";

/**
 * Who else has the page open, in the page header: a few avatars in their cursor colors and "+N"
 * for the rest. Clicking lists everyone by name. Shows nothing while you are alone.
 */
export function PresenceAvatars({ viewers }: { viewers: Presence[] }) {
  const t = useTranslations("page.header");
  if (!viewers.length) return null;
  const { shown, more } = splitViewers(viewers);
  const label = t("viewers", { count: viewers.length });
  const nameOf = (viewer: Presence) => viewer.name || t("someone");
  return (
    <Popover
      align="end"
      // On phones the button isn't at the screen edge, so pin the panel to the viewport instead.
      className="w-60 max-md:fixed max-md:inset-x-4 max-md:top-12 max-md:w-auto"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={label}
          aria-expanded={open}
          className="inline-flex h-7 items-center rounded-md px-1.5 hover:bg-bg-hover"
        >
          <span aria-hidden className="flex items-center -space-x-1.5">
            {shown.map((viewer) => (
              <Avatar key={viewer.id} viewer={viewer} title={nameOf(viewer)} ring />
            ))}
            {more > 0 && (
              <span
                title={viewers.slice(shown.length).map(nameOf).join(", ")}
                className="relative flex h-6 min-w-6 items-center justify-center rounded-full bg-bg-active px-1 text-[11px] font-medium text-fg-muted ring-2 ring-bg"
              >
                +{more}
              </span>
            )}
          </span>
        </button>
      )}
    >
      <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("viewersTitle")}</div>
      <ul className="max-h-64 overflow-y-auto">
        {viewers.map((viewer) => (
          <li key={viewer.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
            <Avatar viewer={viewer} />
            <span className="min-w-0 flex-1 truncate">{nameOf(viewer)}</span>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** Their picture, or their initial in their cursor color. */
function Avatar({ viewer, title, ring = false }: { viewer: Presence; title?: string; ring?: boolean }) {
  const color = userColor(viewer.id);
  return (
    <UserAvatar
      name={viewer.name}
      image={viewer.image}
      size="sm"
      title={title}
      colors="font-semibold"
      style={{ backgroundColor: color, color: textOn(color) }}
      className={cn(ring && "ring-2 ring-bg")}
    />
  );
}
