"use client";

import { Check, Lock, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { mergeCandidatesAction, mergeRowsAction, previewMergeAction } from "@/app/actions/databases";
import { Button, cn, Dialog, DialogFooter, DialogHeader, DialogTitle, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { COMBINE, MAX_MERGE_ROWS, MERGE_TITLE, type MergeChoices } from "@/lib/merge-rows";
import type { MergeCandidate, MergePreview, MergeResult } from "@/server/merge-rows";
import { PropertyTypeIcon } from "./property-icons";
import { Value } from "./row-activity";

/** Over everything else, outside headers whose backdrop blur would hold a fixed overlay to their box. */
function Portal({ children }: { children: React.ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}

/**
 * Merging duplicate rows (server/merge-rows.ts): the row to keep (the oldest to start with), the
 * row each value comes from (or every row's together), and what else moves to the kept row.
 */
export function MergeRowsDialog({
  rowIds,
  onClose,
  onMerged,
}: {
  rowIds: string[];
  onClose: () => void;
  onMerged: (result: MergeResult) => void;
}) {
  const t = useTranslations("database.merge");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keptId, setKeptId] = useState<string | null>(null);
  const [choices, setChoices] = useState<MergeChoices>({});
  const [pending, startTransition] = useTransition();
  const key = rowIds.join();

  useEffect(() => {
    let live = true;
    void previewMergeAction(key.split(","))
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setPreview(result.data);
        const first = result.data.rows[0].id;
        setKeptId(first);
        setChoices(result.data.defaults[first]);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [key, tc]);

  const keep = (id: string) => {
    if (!preview) return;
    setKeptId(id);
    setChoices(preview.defaults[id]);
  };
  const pick = (field: string, choice: string) => setChoices((c) => ({ ...c, [field]: choice }));

  const others = useMemo(() => preview?.rows.filter((r) => r.id !== keptId) ?? [], [preview, keptId]);
  const moving = useMemo(() => {
    const sum = (f: (c: MergePreview["rows"][number]["carries"]) => number) => others.reduce((n, r) => n + f(r.carries), 0);
    return {
      threads: sum((c) => c.threads),
      activity: sum((c) => c.activity),
      files: sum((c) => c.files),
      emails: sum((c) => c.emails),
      links: sum((c) => c.links),
      bodies: sum((c) => (c.body ? 1 : 0)),
      subpages: sum((c) => c.subpages),
    };
  }, [others]);
  const lines = [
    moving.links > 0 && t("movesLinks", { count: moving.links }),
    moving.threads > 0 && t("movesThreads", { count: moving.threads }),
    moving.activity > 0 && t("movesActivity", { count: moving.activity }),
    moving.files > 0 && t("movesFiles", { count: moving.files }),
    moving.emails > 0 && t("movesEmails", { count: moving.emails }),
    moving.bodies > 0 && t("movesBodies", { count: moving.bodies }),
  ].filter((l): l is string => Boolean(l));

  const merge = () =>
    startTransition(async () => {
      if (!preview || !keptId) return;
      setError(null);
      const result = await mergeRowsAction({ keptRowId: keptId, otherRowIds: others.map((r) => r.id), choices }).catch(() => null);
      if (!result?.ok) return setError(result?.error ?? tc("genericError"));
      onMerged(result.data);
    });

  const combinable = preview?.properties.some((p) => p.combinable) ?? false;
  const cell = (selected: boolean) =>
    cn(
      "flex min-h-9 w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-start text-sm transition-colors disabled:cursor-default",
      selected ? "border-accent bg-accent/10" : "border-transparent hover:bg-bg-hover disabled:hover:bg-transparent",
    );
  const tick = (selected: boolean) => (
    <Check className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-accent" : "invisible")} aria-hidden />
  );

  return (
    <Portal>
      <Dialog open onClose={onClose} className="sm:max-w-5xl">
        <div className="flex max-h-[84vh] flex-col">
          <DialogHeader title={t("title", { count: rowIds.length })} description={t("keepHint")} />
          {!preview ? (
            <div className="p-5 text-sm text-fg-muted">{error ?? t("pickLoading")}</div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                <table className="w-full min-w-[40rem] table-fixed border-separate border-spacing-x-1 border-spacing-y-0.5 text-sm">
                  {/* The rows side by side, each as wide as the others. */}
                  <colgroup>
                    <col className="w-40" />
                    {preview.rows.map((row) => (
                      <col key={row.id} />
                    ))}
                    {combinable && <col className="w-36" />}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-2 pb-1 text-start text-xs font-medium text-fg-muted">{t("keep")}</th>
                      {preview.rows.map((row, i) => {
                        const kept = row.id === keptId;
                        return (
                          <th key={row.id} className="pb-1 align-top font-normal">
                            <label
                              className={cn(
                                "flex cursor-pointer items-start gap-2 rounded-md border px-2 py-2 text-start",
                                kept ? "border-accent bg-accent/10" : "border-border hover:bg-bg-hover",
                              )}
                            >
                              <input
                                type="radio"
                                name="kept-row"
                                checked={kept}
                                onChange={() => keep(row.id)}
                                className="mt-0.5 accent-accent"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <PageIcon icon={row.icon} className="h-3.5 w-3.5 shrink-0 text-xs" />
                                  <span className="truncate font-medium text-fg" title={row.title}>
                                    {pageLabel(row.title, tc("untitled"))}
                                  </span>
                                </span>
                                <span className="mt-0.5 block text-xs text-fg-muted">
                                  {t("created", { date: format.dateTime(new Date(row.createdAt), { dateStyle: "medium" }) })}
                                  {i === 0 && <span className="text-fg-faint"> · {t("oldest")}</span>}
                                </span>
                              </span>
                            </label>
                          </th>
                        );
                      })}
                      {combinable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th className="px-2 text-start align-middle font-normal text-fg-muted">
                        <span className="flex items-center gap-1.5">
                          <PropertyTypeIcon type="title" className="h-3.5 w-3.5 shrink-0" />
                          {t("titleField")}
                        </span>
                      </th>
                      {preview.rows.map((row) => {
                        const selected = choices[MERGE_TITLE] === row.id;
                        return (
                          <td key={row.id}>
                            <button type="button" className={cell(selected)} aria-pressed={selected} onClick={() => pick(MERGE_TITLE, row.id)}>
                              {tick(selected)}
                              <span className={cn("min-w-0 truncate", row.title.trim() ? "font-medium text-fg" : "text-fg-faint")}>
                                {pageLabel(row.title, tc("untitled"))}
                              </span>
                            </button>
                          </td>
                        );
                      })}
                      {combinable && <td />}
                    </tr>
                    {preview.properties.map((prop) => {
                      const locked = keptId !== null && !prop.editable[keptId];
                      return (
                        <tr key={prop.id}>
                          <th className="px-2 text-start align-middle font-normal text-fg-muted">
                            <span className="flex items-center gap-1.5" title={locked ? t("locked") : undefined}>
                              <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{prop.name}</span>
                              {locked && <Lock className="h-3 w-3 shrink-0 text-fg-faint" aria-label={t("locked")} />}
                            </span>
                          </th>
                          {preview.rows.map((row) => {
                            const value = prop.values[row.id];
                            const selected = choices[prop.id] === row.id;
                            const empty = !value || value.type === "empty";
                            return (
                              <td key={row.id}>
                                <button
                                  type="button"
                                  className={cell(selected)}
                                  aria-pressed={selected}
                                  disabled={locked || value === null}
                                  title={locked ? t("locked") : undefined}
                                  onClick={() => pick(prop.id, row.id)}
                                >
                                  {tick(selected)}
                                  <span className="min-w-0 break-words">
                                    {value === null ? (
                                      <span className="text-fg-faint">{t("hidden")}</span>
                                    ) : empty ? (
                                      <span className="text-fg-faint">{t("empty")}</span>
                                    ) : (
                                      <Value value={value} />
                                    )}
                                  </span>
                                </button>
                              </td>
                            );
                          })}
                          {combinable && (
                            <td>
                              {prop.combinable && (
                                <button
                                  type="button"
                                  className={cell(choices[prop.id] === COMBINE)}
                                  aria-pressed={choices[prop.id] === COMBINE}
                                  disabled={locked}
                                  onClick={() => pick(prop.id, COMBINE)}
                                >
                                  {tick(choices[prop.id] === COMBINE)}
                                  <span className="text-fg-muted">{t("combine")}</span>
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 border-t border-border px-5 py-3.5 text-sm">
                <div className="font-medium">{t("moves")}</div>
                {lines.length ? (
                  <ul className="list-disc space-y-0.5 ps-5 text-fg-muted">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-fg-muted">{t("movesNothing")}</p>
                )}
                {moving.subpages > 0 && <p className="text-fg-muted">{t("subpages", { count: moving.subpages })}</p>}
                <p className="text-xs text-fg-faint">{t("trashNote")}</p>
              </div>
            </>
          )}
          <DialogFooter>
            {error && preview && <p className="me-auto text-sm text-danger">{error}</p>}
            <Button variant="secondary" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" disabled={!preview || !keptId || pending} onClick={merge}>
              {pending ? t("merging") : t("confirm")}
            </Button>
          </DialogFooter>
        </div>
      </Dialog>
    </Portal>
  );
}

/**
 * "Merge with…" on a row: other rows of its database to pick (by title), then the merge dialog
 * for the row and those.
 */
export function MergeWithDialog({
  rowId,
  onClose,
  onMerged,
}: {
  rowId: string;
  onClose: () => void;
  onMerged: (result: MergeResult) => void;
}) {
  const t = useTranslations("database.merge");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<MergeCandidate[] | null>(null);
  const [picked, setPicked] = useState<MergeCandidate[]>([]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const most = MAX_MERGE_ROWS - 1;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void mergeCandidatesAction(rowId, query)
        .then((result) => {
          if (!live) return;
          if (result.ok) setFound(result.data);
          else setError(result.error);
        })
        .catch(() => live && setError(tc("genericError")));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rowId, query, tc]);

  if (merging) return <MergeRowsDialog rowIds={[rowId, ...picked.map((r) => r.id)]} onClose={onClose} onMerged={onMerged} />;

  const toggle = (row: MergeCandidate) =>
    setPicked((p) => (p.some((r) => r.id === row.id) ? p.filter((r) => r.id !== row.id) : p.length < most ? [...p, row] : p));
  const shown = [...picked, ...(found ?? []).filter((r) => !picked.some((p) => p.id === r.id))];

  return (
    <Portal>
      <Dialog open onClose={onClose} className="max-w-md">
        <div className="flex max-h-[70vh] flex-col">
          <div className="space-y-1.5 px-5 pt-5 pb-3">
            <DialogTitle>{t("pickTitle")}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("pickHint", { count: most })}</p>
          </div>
          <div className="mx-5 flex items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pickSearch")}
              aria-label={t("pickSearch")}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {found === null ? (
              <p className="px-2 py-1.5 text-sm text-fg-muted">{error ?? t("pickLoading")}</p>
            ) : !shown.length ? (
              <p className="px-2 py-1.5 text-sm text-fg-muted">{t("pickEmpty")}</p>
            ) : (
              shown.map((row) => {
                const on = picked.some((r) => r.id === row.id);
                return (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!on && picked.length >= most}
                    onClick={() => toggle(row)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        on ? "border-accent bg-accent text-accent-fg" : "border-border",
                      )}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <PageIcon icon={row.icon} className="h-3.5 w-3.5 shrink-0 text-xs" />
                    <span className="truncate">{pageLabel(row.title, tc("untitled"))}</span>
                  </button>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" disabled={!picked.length} onClick={() => setMerging(true)}>
              {t("pickContinue")}
            </Button>
          </DialogFooter>
        </div>
      </Dialog>
    </Portal>
  );
}
