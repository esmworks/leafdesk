"use client";

import { Search, ShieldAlert, UserRound, Users, UsersRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { loadPropertyAccessAction, setPropertyAccessAction } from "@/app/actions/databases";
import { Button, cn, Dialog } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { namesPeople, PERSON_RULE_LEVELS, propertyRank, type PropertyLevel } from "@/lib/property-access";
import { searchFold } from "@/lib/search-fold";
import { openSharePanel } from "@/lib/share-event";
import { usePropertyAccess } from "./property-access";
import { PropertyTypeIcon } from "./property-icons";
import { useRelations } from "./relation-context";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

type Loaded = Extract<Awaited<ReturnType<typeof loadPropertyAccessAction>>, { ok: true }>["data"];
type Everyone = PropertyLevel | "inherit";

/** An exception as the dialog edits it: who it is for, how they show, and the level it gives. */
type Entry = {
  kind: "user" | "group" | "person";
  id: string;
  name: string;
  detail?: string | null;
  image?: string | null;
  level: PropertyLevel;
};

/** General access, widest first; "inherit" removes the restriction. */
const EVERYONE_LEVELS: Everyone[] = ["inherit", "edit", "edit_values", "view", "view_property", "none"];
/** What an exception can give a person or a group, widest first. */
const EXCEPTION_LEVELS: PropertyLevel[] = ["edit", "edit_values", "view", "view_property"];
/** What an exception can give the people a row names (their rows' values only), widest first. */
const PERSON_LEVELS: PropertyLevel[] = [...PERSON_RULE_LEVELS].reverse();

const MAX_CANDIDATES = 8;

/**
 * Who can see and edit one property and its values: a level for everyone with access to the
 * database, raised for some people, groups or the people a row names. For people with full access to the database.
 */
export function PropertyAccessDialog({ prop, onClose }: { prop: Property; onClose: () => void }) {
  // Rendered from inside a table header: the portal keeps the header's styles and scrolling out.
  if (typeof document === "undefined") return null;
  return createPortal(<AccessDialog prop={prop} onClose={onClose} />, document.body);
}

function AccessDialog({ prop, onClose }: { prop: Property; onClose: () => void }) {
  const t = useTranslations("database.propertyAccess");
  const tc = useTranslations("common");
  const workspaceId = useRelations()?.workspaceId ?? "";
  const schema = useSchema();
  const { refresh } = usePropertyAccess();
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [everyone, setEveryone] = useState<Everyone>("inherit");
  const [exceptions, setExceptions] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let live = true;
    loadPropertyAccessAction(prop.id)
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        setData(res.data);
        setEveryone(res.data.everyone);
        setExceptions(
          res.data.exceptions.map((e) => ({
            kind: e.kind,
            id: e.id,
            name: e.name,
            level: e.level,
            ...(e.kind === "user" ? { detail: e.email, image: e.image } : {}),
          })),
        );
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, prop.id, tc]);

  const inherit = everyone === "inherit";
  // Saving rewrites the rules, logs the change and reloads the database for everyone: only on a change.
  const dirty = useMemo(() => {
    if (!data) return false;
    const key = (list: { kind: string; id: string; level: string }[]) =>
      list.map((e) => `${e.kind}:${e.id}:${e.level}`).sort().join("|");
    return everyone !== data.everyone || key(inherit ? [] : exceptions) !== key(data.exceptions);
  }, [data, everyone, inherit, exceptions]);
  const personProperties = useMemo(() => schema.filter((p) => namesPeople(p.type)), [schema]);
  const taken = useMemo(() => new Set(exceptions.map((e) => `${e.kind}:${e.id}`)), [exceptions]);

  const candidates = useMemo((): Entry[] => {
    if (!data || !searching) return [];
    const q = searchFold(query.trim());
    const matches = (...texts: (string | null | undefined)[]) => !q || texts.some((s) => s && searchFold(s).includes(q));
    const all: Omit<Entry, "level">[] = [
      ...personProperties.map((p) => ({ kind: "person" as const, id: p.id, name: p.name, detail: t("personDetail") })),
      ...data.groups.map((g) => ({ kind: "group" as const, id: g.id, name: g.name, detail: t("groupMembers", { count: g.memberCount }) })),
      ...data.members.map((m) => ({ kind: "user" as const, id: m.id, name: m.name || m.email, detail: m.email, image: m.image })),
    ];
    return all
      .filter((c) => !taken.has(`${c.kind}:${c.id}`) && matches(c.name, c.detail))
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({ ...c, level: defaultLevel(c.kind, everyone) }));
  }, [data, searching, query, personProperties, taken, everyone, t]);

  const changeEveryone = (next: Everyone) => {
    setEveryone(next);
    // Exceptions only raise a lower level for some: without a restriction there's nothing to raise.
    if (next === "inherit") setExceptions([]);
  };

  const add = (entry: Entry) => {
    setExceptions((list) => [...list, entry]);
    setQuery("");
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await setPropertyAccessAction(prop.id, {
        everyone,
        exceptions: inherit
          ? []
          : exceptions.map((e) => ({
              ...(e.kind === "user" ? { userId: e.id } : e.kind === "group" ? { groupId: e.id } : { personPropertyId: e.id }),
              level: e.level,
            })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      refresh?.();
      onClose();
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
            <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{prop.name}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label={tc("close")}
          title={tc("close")}
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!data ? (
        <p className="px-5 py-6 text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? t("loading")}
        </p>
      ) : (
        <div className={cn("max-h-[65vh] overflow-y-auto px-5 py-4", saving && "pointer-events-none opacity-70")}>
          <p className="mb-1 text-xs font-medium text-fg-muted">{t("general")}</p>
          <ul>
            <Row
              avatar={
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-hover text-fg-muted">
                  <Users className="h-4 w-4" aria-hidden />
                </span>
              }
              name={t("everyone")}
              detail={inherit ? t("inheritHint") : undefined}
              control={
                <LevelSelect
                  label={t("general")}
                  value={everyone}
                  levels={EVERYONE_LEVELS}
                  onChange={(level) => changeEveryone(level)}
                />
              }
            />
          </ul>

          {!inherit && data.fullAccess.count > 0 && (
            <div role="note" className="mt-3 flex gap-2.5 rounded-md border border-border px-3 py-2.5 text-xs text-fg-muted">
              <ShieldAlert className="mt-px h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0">
                <p>
                  {t("fullAccess.warning", {
                    count: data.fullAccess.count,
                    names: data.fullAccess.names.join(", "),
                    more: data.fullAccess.count - data.fullAccess.names.length,
                  })}
                </p>
                <button
                  type="button"
                  className="mt-1 font-medium text-accent hover:underline"
                  onClick={() => {
                    onClose();
                    // The header shows the database's Share panel, unless it sits inside another page.
                    if (!openSharePanel(prop.databaseId)) router.push(`/w/${data.workspaceId}/p/${prop.databaseId}?share=1`);
                  }}
                >
                  {t("fullAccess.share")}
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs font-medium text-fg-muted">{t("exceptions")}</p>
            <p className="mt-0.5 mb-2 text-xs text-fg-faint">{inherit ? t("exceptionsNeedGeneral") : t("exceptionsHint")}</p>
            <label
              className={cn(
                "flex h-9 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent",
                inherit && "opacity-50",
              )}
            >
              <Search className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
              <input
                value={query}
                disabled={inherit}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearching(true)}
                onBlur={() => setSearching(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && candidates[0]) {
                    e.preventDefault();
                    add(candidates[0]);
                  }
                }}
                placeholder={t("addException")}
                aria-label={t("addException")}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint disabled:cursor-not-allowed"
              />
            </label>
            {searching && !inherit && (
              <div className="mt-1 rounded-lg border border-border p-1">
                {candidates.map((c) => (
                  <button
                    key={`${c.kind}:${c.id}`}
                    type="button"
                    // Keeps the search box focused, so the list stays open for the next pick.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(c)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover"
                  >
                    <EntryAvatar entry={c} />
                    <Label name={c.name} detail={c.detail} />
                  </button>
                ))}
                {!candidates.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noMatches")}</p>}
              </div>
            )}
            {exceptions.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {exceptions.map((entry) => {
                  const noEffect = !inherit && propertyRank(entry.level) <= propertyRank(everyone as PropertyLevel);
                  return (
                    <Row
                      key={`${entry.kind}:${entry.id}`}
                      avatar={<EntryAvatar entry={entry} />}
                      name={entry.name || "?"}
                      detail={noEffect ? t("noEffect") : entry.detail}
                      control={
                        <div className="flex items-center gap-0.5">
                          <LevelSelect
                            label={t("levelFor", { name: entry.name })}
                            value={entry.level}
                            levels={entry.kind === "person" ? PERSON_LEVELS : EXCEPTION_LEVELS}
                            onChange={(level) =>
                              setExceptions((list) =>
                                list.map((e) => (e.kind === entry.kind && e.id === entry.id ? { ...e, level } : e)),
                              )
                            }
                          />
                          <button
                            type="button"
                            aria-label={t("removeException", { name: entry.name })}
                            title={tc("remove")}
                            onClick={() =>
                              setExceptions((list) => list.filter((e) => !(e.kind === entry.kind && e.id === entry.id)))
                            }
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      }
                    />
                  );
                })}
              </ul>
            )}
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs text-fg-faint">{t("note")}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {error && (
          <p role="alert" className="mr-auto text-xs text-danger">
            {error}
          </p>
        )}
        <Button variant="ghost" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" disabled={!data || saving || !dirty} onClick={() => void save()}>
          {saving ? tc("saving") : tc("save")}
        </Button>
      </div>
    </Dialog>
  );
}

/** A new exception starts one step above everyone else, where that is something it can give. */
function defaultLevel(kind: Entry["kind"], everyone: Everyone): PropertyLevel {
  const levels = kind === "person" ? PERSON_LEVELS : EXCEPTION_LEVELS;
  const floor = everyone === "inherit" ? -1 : propertyRank(everyone);
  const above = [...levels].reverse().find((level) => propertyRank(level) > floor);
  return above ?? levels[0];
}

function EntryAvatar({ entry }: { entry: Pick<Entry, "kind" | "name" | "image"> }) {
  if (entry.kind === "user") {
    return <UserAvatar name={entry.name || "?"} image={entry.image} size="md" colors="bg-accent/15 text-accent" />;
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
      {entry.kind === "group" ? <UsersRound className="h-3.5 w-3.5" aria-hidden /> : <UserRound className="h-3.5 w-3.5" aria-hidden />}
    </span>
  );
}

function Row({ avatar, name, detail, control }: { avatar: ReactNode; name: string; detail?: string | null; control: ReactNode }) {
  return (
    <li className="flex list-none items-center gap-2 py-1">
      {avatar}
      <div className="min-w-0 flex-1">
        <Label name={name} detail={detail} />
      </div>
      <div className="shrink-0">{control}</div>
    </li>
  );
}

function Label({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm">{name}</div>
      {detail && (
        <div className="truncate text-xs text-fg-muted" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function LevelSelect<L extends Everyone>({
  label,
  value,
  levels,
  onChange,
}: {
  label: string;
  value: L;
  levels: readonly L[];
  onChange: (level: L) => void;
}) {
  const t = useTranslations("database.propertyAccess.levels");
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as L)}
      className="h-7 max-w-52 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
    >
      {levels.map((level) => (
        <option key={level} value={level}>
          {t(level as Everyone)}
        </option>
      ))}
    </select>
  );
}
