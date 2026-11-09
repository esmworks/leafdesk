"use client";

/**
 * Chosen people as chips, and a search box to add more: automations' notify steps, buttons and the
 * request for approval of a page (page/approval-dialog) pick people with it.
 */
import { Search, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { searchFold } from "@/lib/search-fold";

export type PickablePerson = { id: string; name: string; email: string | null; image?: string | null };

const MAX_CANDIDATES = 8;

/** Chosen people as chips, and a search box to add more (as in the property access dialog); `max` stops adding past it. */
export function PeoplePicker({
  people,
  selected,
  onChange,
  max,
}: {
  people: PickablePerson[];
  selected: string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const candidates = useMemo(() => {
    if (!searching) return [];
    const q = searchFold(query.trim());
    return people
      .filter((p) => !selected.includes(p.id))
      .filter((p) => !q || searchFold(p.name).includes(q) || (p.email !== null && searchFold(p.email).includes(q)))
      .slice(0, MAX_CANDIDATES);
  }, [people, selected, query, searching]);
  const full = max !== undefined && selected.length >= max;
  const add = (id: string) => {
    if (full) return;
    onChange([...selected, id]);
    setQuery("");
  };

  return (
    <div>
      {selected.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((id) => {
            const person = people.find((p) => p.id === id);
            const name = person?.name || person?.email || t("unknownPerson");
            return (
              <li key={id} className="inline-flex items-center gap-1 rounded-md bg-bg-hover py-0.5 pe-1 ps-0.5 text-sm">
                {person ? (
                  <UserAvatar name={name} image={person.image} size="xs" colors="bg-accent/15 text-accent" />
                ) : (
                  <UserRound className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
                )}
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`${tc("remove")}: ${name}`}
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  className="rounded text-fg-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
        <Search className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
        <input
          value={query}
          disabled={full}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearching(true)}
          onBlur={() => setSearching(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (candidates[0]) add(candidates[0].id);
            }
          }}
          placeholder={t("form.addPerson")}
          aria-label={t("form.addPerson")}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint disabled:opacity-60"
        />
      </label>
      {searching && !full && (
        <div className="mt-1 rounded-lg border border-border p-1">
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              // Keeps the search box focused, so the list stays open for the next pick.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
            >
              <UserAvatar name={p.name || p.email || "?"} image={p.image} size="md" colors="bg-accent/15 text-accent" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{p.name || p.email}</span>
                {p.email && p.name && <span className="block truncate text-xs text-fg-muted">{p.email}</span>}
              </span>
            </button>
          ))}
          {!candidates.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("form.noMatches")}</p>}
        </div>
      )}
    </div>
  );
}
