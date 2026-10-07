"use client";

import { Bot, Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { PersonRef, Property } from "./types";
import { searchFold } from "@/lib/search-fold";

export type PeopleContextValue = {
  /** The signed-in user: "me" in person filters, "(you)" in the picker. */
  viewerId: string | null;
  /** People person values can show; active ones can be assigned. */
  people: PersonRef[];
};

const PeopleContext = createContext<PeopleContextValue>({ viewerId: null, people: [] });

export const PeopleProvider = PeopleContext.Provider;

export function usePeople() {
  return useContext(PeopleContext);
}

/** People of a person value the viewer knows about, in the stored order. */
export function assignedPeople(people: PersonRef[], value: unknown): PersonRef[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map(people.map((p) => [p.id, p]));
  return value.flatMap((id) => {
    const person = typeof id === "string" ? byId.get(id) : undefined;
    return person ? [person] : [];
  });
}

export function PersonAvatar({
  person,
  className,
}: {
  person: Pick<PersonRef, "name" | "active" | "image" | "isAgent" | "agentIcon">;
  className?: string;
}) {
  // An agent shows its icon, or a robot when it has none.
  if (person.isAgent) {
    return (
      <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded bg-bg-active text-[11px] text-fg-muted", className)} aria-hidden>
        {person.agentIcon || <Bot className="h-3 w-3" />}
      </span>
    );
  }
  return (
    <UserAvatar
      name={person.name}
      // Former members show their initial, muted, like their name.
      image={person.active ? person.image : null}
      size="xs"
      colors={person.active ? "bg-accent/15 text-accent" : "bg-bg-active text-fg-muted"}
      className={className}
    />
  );
}

function PersonChip({ person }: { person: PersonRef }) {
  const t = useTranslations("database.person");
  const tc = useTranslations("common");
  return (
    <span
      className={cn("inline-flex max-w-full min-w-0 shrink-0 items-center gap-1.5", !person.active && !person.isAgent && "text-fg-muted")}
      title={person.isAgent ? tc("agent") : person.active ? (person.email ?? undefined) : t("former")}
    >
      <PersonAvatar person={person} />
      <span className="truncate">{person.name || t("unknown")}</span>
    </span>
  );
}

/** Read-only list of assigned people (table cells, cards, panels). */
export function PersonChips({ value, wrap }: { value: unknown; wrap?: boolean }) {
  const { people } = usePeople();
  const assigned = assignedPeople(people, value);
  if (!assigned.length) return null;
  return (
    <span className={cn("flex min-w-0 gap-x-2.5 gap-y-0.5", wrap ? "flex-wrap" : "overflow-hidden")}>
      {assigned.map((person) => (
        <PersonChip key={person.id} person={person} />
      ))}
    </span>
  );
}

/** Search the workspace's people and toggle who is assigned. */
export function PersonPicker({
  prop,
  value,
  onChange,
}: {
  prop: Property;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("database.person");
  const { people, viewerId } = usePeople();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Local selection so quick toggles don't race the optimistic parent state.
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  // Case-insensitive, with the dotted and dotless i alike (see searchFold).
  const lower = searchFold;
  const q = lower(query.trim());
  const candidates = people.filter((p) => p.active);
  const items = q
    ? candidates.filter((p) => lower(p.name).includes(q) || (p.email !== null && lower(p.email).includes(q)))
    : candidates;
  const selected = assignedPeople(people, selectedIds);
  const nameOf = (person: PersonRef) => {
    const name = person.name || t("unknown");
    return person.id === viewerId ? t("you", { name }) : name;
  };

  const setIds = (ids: string[]) => {
    setSelectedIds(ids);
    onChange(ids.length ? ids : null);
  };
  const toggle = (id: string) =>
    setIds(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  return (
    <div className="w-72">
      <div className="border-b border-border bg-bg-subtle px-2 py-1.5">
        <input
          ref={input}
          value={query}
          placeholder={t("search")}
          aria-label={t("input", { property: prop.name })}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = items[active];
              if (item) toggle(item.id);
            } else if (e.key === "Backspace" && !query && selectedIds.length) {
              setIds(selectedIds.slice(0, -1));
            }
          }}
          className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      {selected.length > 0 && (
        <div className="border-b border-border p-1">
          <div className="px-2 pt-1 pb-1 text-xs text-fg-muted">{t("assigned")}</div>
          {selected.map((person) => (
            <div
              key={person.id}
              className={cn("flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg-hover", !person.active && "text-fg-muted")}
              title={person.active ? undefined : t("former")}
            >
              <PersonAvatar person={person} />
              <span className="flex-1 truncate">{nameOf(person)}</span>
              <button
                type="button"
                aria-label={t("remove", { name: person.name })}
                title={t("remove", { name: person.name })}
                onClick={() => toggle(person.id)}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto p-1">
        {items.length > 0 ? (
          <div className="px-2 pt-1 pb-1 text-xs text-fg-muted">{t("people")}</div>
        ) : (
          <div className="px-2 py-1.5 text-xs text-fg-faint">{candidates.length ? t("noMatches") : t("noPeople")}</div>
        )}
        {items.map((person, i) => (
          <button
            key={person.id}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => toggle(person.id)}
            className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm", i === active && "bg-bg-hover")}
          >
            <PersonAvatar person={person} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{nameOf(person)}</span>
              {person.email && <span className="block truncate text-xs text-fg-muted">{person.email}</span>}
            </span>
            {selectedIds.includes(person.id) && <Check className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
          </button>
        ))}
      </div>
    </div>
  );
}
