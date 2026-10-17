import { CalendarCheck, CalendarPlus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import type { DailyNoteSummary } from "@/server/journal";
import { OpenDailyNoteButton } from "./daily-notes";

const cardClass = "flex w-full items-center gap-2.5 rounded-md border border-border px-4 py-3 text-start text-sm hover:bg-bg-hover";

/**
 * The home page's daily note: today's to open (or start), and the few before it. `notes` are the
 * user's latest, newest first; `today` is the viewer's day.
 */
export async function TodayNoteSection({ workspaceId, today, notes }: { workspaceId: string; today: string; notes: DailyNoteSummary[] }) {
  const [t, tc] = await Promise.all([getTranslations("journal"), getTranslations("common")]);
  const todays = notes.find((n) => n.day === today);
  const earlier = notes.filter((n) => n.day < today).slice(0, 4);

  return (
    <section className="space-y-3" aria-labelledby="today-note-heading">
      <h2 id="today-note-heading" className="text-sm font-semibold">
        {t("todayNote")}
      </h2>
      {todays ? (
        <Link href={`/w/${workspaceId}/p/${todays.pageId}`} className={cardClass}>
          <CalendarCheck className="h-4 w-4 shrink-0 text-accent" />
          <span className="flex-1 truncate">{pageLabel(todays.title, tc("untitled"))}</span>
          <span className="text-xs text-fg-muted">{t("openToday")}</span>
        </Link>
      ) : (
        <OpenDailyNoteButton workspaceId={workspaceId} className={`${cardClass} disabled:opacity-60`}>
          <CalendarPlus className="h-4 w-4 shrink-0 text-fg-muted" />
          <span className="flex-1">{t("startToday")}</span>
        </OpenDailyNoteButton>
      )}
      {earlier.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-fg-muted">{t("recent")}</h3>
          <ul className="grid gap-1 sm:grid-cols-2">
            {earlier.map((note) => (
              <li key={note.day}>
                <Link
                  href={`/w/${workspaceId}/p/${note.pageId}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <PageIcon icon={note.icon} className="shrink-0" />
                  <span className="truncate">{pageLabel(note.title, tc("untitled"))}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
