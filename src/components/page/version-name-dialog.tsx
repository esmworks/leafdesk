"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { renameVersionAction, saveVersionAction, versionSaveStateAction } from "@/app/actions/pages";
import { Button, Dialog, Input } from "@/components/ui";
import { MAX_VERSION_NAME } from "@/lib/page-versions";
import { isMac, savesVersion } from "@/lib/shortcuts";

/**
 * The prompt for a version's name (lib/page-versions): saving the page as a version (Mod+S on the
 * page, or Save version in its history), or naming one already saved. When nothing changed since
 * the newest version, saving offers to name that one instead of keeping a copy of it. An empty
 * name saves the version unnamed, or clears the name of one already saved.
 */
export type VersionNameTarget =
  | { kind: "save"; pageId: string }
  | { kind: "rename"; versionId: string; name: string | null; savedAt: Date | string };

/** What happened: a new version was saved (`saved`), or an existing one got `name`. */
export type VersionNamed = { id: string; name: string | null; saved: boolean };

type Problem = "invalidName" | "inTrash" | "failed" | "state";

export function VersionNameDialog({
  target,
  onDone,
  onClose,
}: {
  target: VersionNameTarget;
  onDone: (result: VersionNamed) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.history.versionName");
  const tc = useTranslations("common");
  const format = useFormatter();
  // Saving: null while it is found out whether anything changed since the newest version; then
  // that version when nothing did (it is named instead), else "new".
  const [unchanged, setUnchanged] = useState<{ id: string; name: string | null; createdAt: Date } | "new" | null>(
    target.kind === "save" ? null : "new",
  );
  const [name, setName] = useState(target.kind === "rename" ? (target.name ?? "") : "");
  const [error, setError] = useState<Problem | null>(null);
  const [pending, startTransition] = useTransition();
  const pageId = target.kind === "save" ? target.pageId : null;

  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    versionSaveStateAction(pageId)
      .then((state) => {
        if (cancelled) return;
        if (state.latest && !state.changed) {
          setUnchanged(state.latest);
          setName(state.latest.name ?? "");
        } else setUnchanged("new");
      })
      .catch(() => {
        if (cancelled) return;
        // Saving still works: the server names the newest version itself when nothing changed.
        setUnchanged("new");
        setError("state");
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const renaming = target.kind === "rename" ? { id: target.versionId, savedAt: target.savedAt } : unchanged && unchanged !== "new" ? { id: unchanged.id, savedAt: unchanged.createdAt } : null;
  const date = (value: Date | string) => format.dateTime(new Date(value), { dateStyle: "medium", timeStyle: "short" });

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        if (renaming) {
          const result = await renameVersionAction(renaming.id, name);
          if (!result.ok) return setError(result.error);
          onDone({ id: renaming.id, name: result.data.name, saved: false });
        } else if (pageId) {
          const result = await saveVersionAction(pageId, name);
          if (!result.ok) return setError(result.error);
          onDone({ id: result.data.id, name: result.data.name, saved: !result.data.renamed });
        }
      } catch {
        setError("failed");
      }
    });
  }

  const loading = unchanged === null;
  const title = target.kind === "rename" ? t("renameTitle") : renaming ? t("unchangedTitle") : t("saveTitle");
  const hint =
    target.kind === "rename"
      ? t("renameHint", { date: date(target.savedAt) })
      : renaming
        ? t("unchangedHint", { date: date(renaming.savedAt) })
        : t("saveHint");

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && !pending) submit();
        }}
        // Mod+S again saves, rather than the browser saving the web page.
        onKeyDown={(e) => {
          if (!savesVersion(e.nativeEvent, isMac())) return;
          e.preventDefault();
          if (!loading && !pending) submit();
        }}
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-fg-muted">{loading ? tc("loading") : hint}</p>
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("nameLabel")}</span>
          <Input
            autoFocus
            value={name}
            maxLength={MAX_VERSION_NAME}
            placeholder={t("namePlaceholder")}
            disabled={loading}
            aria-invalid={error === "invalidName" || undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError((current) => (current === "invalidName" ? null : current));
            }}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {t(`errors.${error}`, { max: MAX_VERSION_NAME })}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={loading || pending}>
            {pending ? t("saving") : renaming ? t("saveName") : t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
