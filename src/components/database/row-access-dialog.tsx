"use client";

/**
 * A database's row access (page menu, full access): the people a row names, in a person property
 * or as its creator, get access to that row; optionally each row is kept from everyone else.
 * Applied by the server (server/row-access.ts) to every check and list.
 */
import { EyeOff, Plus, ShieldAlert, UserPen, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { loadRowAccessAction, setRowAccessAction } from "@/app/actions/databases";
import { Button, cn, Dialog, Switch } from "@/components/ui";
import { MAX_ROW_ACCESS_RULES, ROW_ACCESS_LEVELS, type RowAccessLevel, type RowAccessRule } from "@/lib/row-access";
import { openSharePanel } from "@/lib/share-event";

type Loaded = Extract<Awaited<ReturnType<typeof loadRowAccessAction>>, { ok: true }>["data"];

/** Widest first, like the share panel. */
const LEVELS = [...ROW_ACCESS_LEVELS].reverse();

const ruleKey = (rule: RowAccessRule) => (rule.kind === "creator" ? "creator" : `person:${rule.propertyId}`);

export function RowAccessDialog({
  workspaceId,
  databaseId,
  open,
  onClose,
}: {
  workspaceId: string;
  databaseId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("database.rowAccess");
  const tc = useTranslations("common");
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [rules, setRules] = useState<RowAccessRule[]>([]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setData(null);
    setLoadError(null);
    setError(null);
    loadRowAccessAction(databaseId)
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        setData(res.data);
        setRestricted(res.data.restricted);
        setRules(res.data.rules);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [open, databaseId, tc]);

  // Saving checks open editors and reloads the database for everyone: only on a change.
  const dirty = useMemo(() => {
    if (!data) return false;
    const key = (list: RowAccessRule[]) => list.map((r) => `${ruleKey(r)}:${r.level}`).sort().join("|");
    return restricted !== data.restricted || key(rules) !== key(data.rules);
  }, [data, restricted, rules]);

  const nameOf = (rule: RowAccessRule) =>
    rule.kind === "creator" ? t("creator") : (data?.personProperties.find((p) => p.id === rule.propertyId)?.name ?? "?");

  // What a new rule can name: the person properties and the creator not named yet.
  const available = useMemo((): RowAccessRule[] => {
    if (!data) return [];
    const taken = new Set(rules.map(ruleKey));
    const options: RowAccessRule[] = [
      ...data.personProperties.map((p): RowAccessRule => ({ kind: "person", propertyId: p.id, level: "edit" })),
      { kind: "creator", level: "edit" },
    ];
    return options.filter((r) => !taken.has(ruleKey(r)));
  }, [data, rules]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await setRowAccessAction(databaseId, { restricted, rules });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  if (!open || typeof document === "undefined") return null;
  // A portal: the page header's blurred background would otherwise hold the fixed overlay inside it.
  return createPortal(
    <Dialog open onClose={saving ? () => {} : onClose} className="max-w-lg">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-0.5 text-sm text-fg-muted">{t("description")}</p>
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
          <p className="text-xs font-medium text-fg-muted">{t("rules")}</p>
          <p className="mt-0.5 mb-2 text-xs text-fg-faint">
            {data.personProperties.length ? t("rulesHint") : t("noPersonProperties")}
          </p>
          {rules.length > 0 && (
            <ul className="space-y-0.5">
              {rules.map((rule) => {
                const name = nameOf(rule);
                return (
                  <li key={ruleKey(rule)} className="flex items-center gap-2 py-1">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                      {rule.kind === "creator" ? (
                        <UserPen className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <UserRound className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{name}</div>
                      <div className="text-xs text-fg-muted">
                        {rule.kind === "creator" ? t("creatorDetail") : t("personDetail")}
                      </div>
                    </div>
                    <select
                      value={rule.level}
                      aria-label={t("levelFor", { name })}
                      onChange={(e) => {
                        const level = e.target.value as RowAccessLevel;
                        setRules((list) => list.map((r) => (ruleKey(r) === ruleKey(rule) ? { ...r, level } : r)));
                      }}
                      className="h-7 max-w-44 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
                    >
                      {LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {t(`levels.${level}`)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={t("removeRule", { name })}
                      title={tc("remove")}
                      onClick={() => setRules((list) => list.filter((r) => ruleKey(r) !== ruleKey(rule)))}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {available.length > 0 && rules.length < MAX_ROW_ACCESS_RULES && (
            <label className="mt-2 flex h-9 items-center gap-2 rounded-md border border-border px-2 text-sm text-fg-muted focus-within:border-accent">
              <Plus className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
              <select
                value=""
                aria-label={t("addRule")}
                onChange={(e) => {
                  const rule = available.find((r) => ruleKey(r) === e.target.value);
                  if (rule) setRules((list) => [...list, rule]);
                }}
                className="min-w-0 flex-1 bg-transparent outline-none"
              >
                <option value="" disabled>
                  {t("addRule")}
                </option>
                {available.map((rule) => (
                  <option key={ruleKey(rule)} value={ruleKey(rule)}>
                    {nameOf(rule)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="mt-4 border-t border-border pt-4">
            <div className="flex items-start gap-2.5">
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{t("restricted")}</p>
                <p className="mt-0.5 text-xs text-fg-muted">{t("restrictedHint")}</p>
              </div>
              <Switch checked={restricted} onChange={setRestricted} label={t("restricted")} />
            </div>
            {restricted && data.fullAccess.count > 0 && (
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
                      if (!openSharePanel(databaseId)) router.push(`/w/${workspaceId}/p/${databaseId}?share=1`);
                    }}
                  >
                    {t("fullAccess.share")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs text-fg-faint">{t("note")}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {error && (
          <p role="alert" className="me-auto text-xs text-danger">
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
    </Dialog>,
    document.body,
  );
}
