"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { Input, PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { type DirectoryPerson, matchesPerson } from "@/lib/people";

/** The people directory (/w/[id]/people): a card per owner or member, filtered as you type. */
export function PeopleDirectory({
  workspaceId,
  currentUserId,
  people,
  now,
}: {
  workspaceId: string;
  currentUserId: string;
  people: DirectoryPerson[];
  /** Render time from the server, so relative dates match between server and client render. */
  now: Date;
}) {
  const t = useTranslations("people");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => people.filter((p) => matchesPerson(p, query)), [people, query]);

  return (
    <div className="mx-auto max-w-4xl px-4 pt-14 pb-12 md:px-6 md:pt-12">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("heading")}</h1>
        <p className="mt-2 text-sm text-fg-muted">{t("description")}</p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <Input
            type="search"
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full ps-7"
          />
        </div>
        <span className="text-sm text-fg-muted" aria-live="polite">
          {t("count", { count: shown.length })}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("noMatches")}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {shown.map((person) => (
            <li key={person.userId}>
              <PersonCard workspaceId={workspaceId} person={person} isSelf={person.userId === currentUserId} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonCard({
  workspaceId,
  person,
  isSelf,
  now,
}: {
  workspaceId: string;
  person: DirectoryPerson;
  isSelf: boolean;
  now: Date;
}) {
  const t = useTranslations("people");
  const tm = useTranslations("settings.members");
  const tc = useTranslations("common");
  const format = useFormatter();
  const label = person.name || person.email;

  return (
    <article aria-label={label} className="flex h-full flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <UserAvatar name={label} image={person.image} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {person.name}
            {isSelf && <span className="font-normal text-fg-muted"> {t("you")}</span>}
          </div>
          <a href={`mailto:${person.email}`} className="block truncate text-sm text-fg-muted hover:text-fg hover:underline">
            {person.email}
          </a>
        </div>
        <span className="shrink-0 text-xs text-fg-muted">{tm(`roles.${person.role}`)}</span>
      </div>

      <Labels title={t("teamspaces")} empty={t("none")} items={person.teamspaces.map((ts) => ({ id: ts.id, name: ts.name, icon: ts.icon }))} />
      <Labels title={t("groups")} empty={t("none")} items={person.groups.map((g) => ({ id: g.id, name: g.name, icon: null }))} />

      <section>
        <h2 className="mb-1 text-xs font-medium text-fg-muted">{t("recentPages")}</h2>
        {person.recentPages.length === 0 ? (
          <p className="text-sm text-fg-faint">{t("noRecentPages")}</p>
        ) : (
          <ul className="-mx-1.5 space-y-px">
            {person.recentPages.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${workspaceId}/p/${p.id}`}
                  className="flex h-7 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-bg-hover"
                >
                  <PageIcon icon={p.icon} kind={p.kind} className="text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate">{pageLabel(p.title, tc("untitled"))}</span>
                  <time
                    dateTime={p.editedAt.toISOString()}
                    title={format.dateTime(p.editedAt, { dateStyle: "medium", timeStyle: "short" })}
                    className="shrink-0 text-xs text-fg-muted"
                  >
                    {format.relativeTime(p.editedAt, now)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/** A titled row of teamspace or group names; "None" when empty. */
function Labels({ title, empty, items }: { title: string; empty: string; items: { id: string; name: string; icon: string | null }[] }) {
  return (
    <section>
      <h2 className="mb-1 text-xs font-medium text-fg-muted">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-fg-faint">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-bg-hover px-1.5 text-xs">
              {item.icon && (
                <span aria-hidden>
                  <IconGlyph icon={item.icon} />
                </span>
              )}
              <span className="truncate">{item.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
