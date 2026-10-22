"use client";

import { Search, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { IconButton, Input, Switch } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { hasTemplate } from "@/lib/automation-templates";
import { isDynamicValue } from "@/lib/automations";
import { searchFold } from "@/lib/search-fold";
import { canFill, initialValue, optionsOf, shownNumber, TEMPLATE_ONLY_TYPES, type Person, type SetEntry } from "./automations-shared";
import { TemplateField, VariableButton } from "./automations-variables";
import { OptionChip } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import type { Property } from "./types";

export const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

const MAX_CANDIDATES = 8;

/** Text-like types: their value is typed, templates and all. */
const TYPED = ["text", "number", "url", "email", "phone"];

/**
 * Pairs of a property (of `properties`: this database's, or the one the step writes to) and the
 * value to set it to.
 */
export function ValuesEditor({
  entries,
  properties,
  people,
  noActor,
  onChange,
}: {
  entries: SetEntry[];
  properties: Property[];
  people: Person[];
  /** Nobody's change starts the automation: no "whoever made the change". */
  noActor: boolean;
  onChange: (entries: SetEntry[]) => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const used = new Set(entries.map((e) => e.propertyId));
  const available = properties.filter((p) => canFill(p) && !used.has(p.id));
  const setEntry = (index: number, entry: SetEntry) => onChange(entries.map((e, i) => (i === index ? entry : e)));

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => {
        const prop = properties.find((p) => p.id === entry.propertyId);
        return (
          <div key={entry.propertyId} className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
            <span className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 text-sm sm:w-36">
              {prop ? (
                <>
                  <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                  <span className="truncate">{prop.name}</span>
                </>
              ) : (
                <span className="truncate text-fg-muted">{t("deletedProperty")}</span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              {prop && (
                <ValueEditor prop={prop} value={entry.value} people={people} noActor={noActor} onChange={(value) => setEntry(index, { ...entry, value })} />
              )}
            </div>
            <IconButton label={tc("remove")} onClick={() => onChange(entries.filter((_, i) => i !== index))} className="mt-1 hover:text-danger">
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        );
      })}
      {available.length > 0 && (
        <select
          value=""
          aria-label={t("form.addProperty")}
          onChange={(e) => {
            const prop = available.find((p) => p.id === e.target.value);
            if (prop) onChange([...entries, { propertyId: prop.id, value: initialValue(prop) }]);
          }}
          className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
        >
          <option value="">+ {t("form.addProperty")}</option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * The value a step gives one property. Text-like properties take text with variables; the others
 * a value of their kind, or a variable instead (picked with the button next to them).
 */
export function ValueEditor({
  prop,
  value,
  people,
  noActor = false,
  onChange,
}: {
  prop: Property;
  value: unknown;
  people: Person[];
  noActor?: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("database.automations");
  const label = t("form.valueFor", { property: prop.name });
  const templateOnly = (TEMPLATE_ONLY_TYPES as readonly string[]).includes(prop.type);

  if (TYPED.includes(prop.type) || templateOnly || hasTemplate(value)) {
    const text = typeof value === "string" ? value : typeof value === "number" ? shownNumber(prop, value) : "";
    return (
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <TemplateField
            aria-label={label}
            value={text}
            inputMode={prop.type === "number" && !hasTemplate(text) ? "decimal" : undefined}
            placeholder={templateOnly ? t("form.relationPlaceholder", { template: "{{find.rows}}" }) : undefined}
            onChange={onChange}
          />
        </div>
        {!TYPED.includes(prop.type) && !templateOnly && (
          <IconButton label={t("form.clearVariable")} onClick={() => onChange(initialValue(prop))} className="mt-1">
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <PlainValueEditor prop={prop} value={value} people={people} noActor={noActor} label={label} onChange={onChange} />
      </div>
      <VariableButton onPick={(template) => onChange(template)} />
    </div>
  );
}

function PlainValueEditor({
  prop,
  value,
  people,
  noActor,
  label,
  onChange,
}: {
  prop: Property;
  value: unknown;
  people: Person[];
  noActor: boolean;
  label: string;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("database.automations");
  switch (prop.type) {
    case "select":
    case "status":
      return (
        <select value={typeof value === "string" ? value : ""} aria-label={label} onChange={(e) => onChange(e.target.value)} className={selectClass}>
          <option value="">{t("form.choose")}</option>
          {optionsOf(prop).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const options = optionsOf(prop);
      const rest = options.filter((o) => !ids.includes(o.id));
      return (
        <div className="flex min-h-8 flex-wrap items-center gap-1">
          {ids.map((id) => {
            const option = options.find((o) => o.id === id);
            return option ? <OptionChip key={id} option={option} onRemove={() => onChange(ids.filter((x) => x !== id))} /> : null;
          })}
          {rest.length > 0 && (
            <select
              value=""
              aria-label={label}
              onChange={(e) => e.target.value && onChange([...ids, e.target.value])}
              className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
            >
              <option value="">+ {t("form.addOption")}</option>
              {rest.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    case "checkbox":
      return (
        <div className="flex h-8 items-center gap-2 text-sm">
          <Switch checked={value === true} label={label} onChange={onChange} />
          <span className="text-fg-muted">{value === true ? t("checked") : t("unchecked")}</span>
        </div>
      );
    case "date": {
      const now = isDynamicValue(value) && value.$ === "now";
      return (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <select
            value={now ? "now" : "date"}
            aria-label={label}
            onChange={(e) => onChange(e.target.value === "now" ? { $: "now" } : "")}
            className={selectClass}
          >
            <option value="now">{t("form.now")}</option>
            <option value="date">{t("form.specificDate")}</option>
          </select>
          {!now && (
            <Input
              type="date"
              aria-label={label}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              className="[color-scheme:light_dark]"
            />
          )}
        </div>
      );
    }
    case "person": {
      const actor = isDynamicValue(value) && value.$ === "actor";
      if (noActor) {
        return <PeoplePicker people={people} selected={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
      }
      return (
        <div className="space-y-1.5">
          <select
            value={actor ? "actor" : "people"}
            aria-label={label}
            onChange={(e) => onChange(e.target.value === "actor" ? { $: "actor" } : [])}
            className={selectClass}
          >
            <option value="actor">{t("form.actor")}</option>
            <option value="people">{t("form.specificPeople")}</option>
          </select>
          {!actor && <PeoplePicker people={people} selected={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />}
        </div>
      );
    }
    default:
      return null;
  }
}

/** Chosen people as chips, and a search box to add more (as in the property access dialog). */
export function PeoplePicker({
  people,
  selected,
  onChange,
}: {
  people: Person[];
  selected: string[];
  onChange: (ids: string[]) => void;
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
  const add = (id: string) => {
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
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </label>
      {searching && (
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
