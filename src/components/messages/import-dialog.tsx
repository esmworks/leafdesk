"use client";

import { FileArchive, Hash, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Switch } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { IMPORT_LIMITS } from "@/lib/import/markdown";
import type { SlackImportResult, SlackImportWarning } from "@/lib/import/slack";
import { messagesPath } from "@/lib/messages";

const ERRORS = ["tooLarge", "tooManyFiles", "badZip", "badSlack", "busy", "noAccess"] as const;

/**
 * Imports a Slack workspace export into Messages (workspace owners; the server checks again):
 * the export's ZIP goes to /api/import as `mode=slack`, and what came in, was renamed or was left
 * out is shown when it's done.
 */
export function ImportDialog({ workspaceId, open, close }: { workspaceId: string; open: boolean; close: () => void }) {
  const t = useTranslations("messages.import");
  const common = useTranslations("common");
  const [chosen, setChosen] = useState<File | null>(null);
  const [download, setDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SlackImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setChosen(null);
    setDownload(false);
    setError(null);
    setResult(null);
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen || busy) return;
    if (chosen.size > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("mode", "slack");
    form.append("workspaceId", workspaceId);
    if (download) form.append("download", "1");
    form.append("file", chosen);
    try {
      const response = await fetch("/api/import", { method: "POST", body: form, headers: { "X-Leafdesk-Import": "1" } });
      const body = (await response.json().catch(() => null)) as (SlackImportResult & { code?: string; params?: Record<string, string | number> }) | null;
      if (!response.ok || !body?.channels) {
        const code = ERRORS.find((c) => c === body?.code);
        const params = { ...body?.params };
        if (typeof params.limit === "number" && code === "tooLarge") params.limit = formatBytes(params.limit);
        setError(code ? t(`errors.${code}`, params) : t("errors.failed"));
        return;
      }
      setResult(body);
    } catch {
      setError(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  const go = (channelId: string) => {
    window.history.pushState(null, "", messagesPath(workspaceId, { channelId }));
    close();
  };

  if (result) {
    return (
      <Dialog open={open} onClose={close}>
        <DialogHeader title={t("doneTitle")} onClose={close} closeLabel={common("close")} />
        <DialogBody className="space-y-4">
          <p className="text-sm text-fg">
            {t("doneSummary", { channels: result.created.channels, messages: result.created.messages, people: result.people.matched })}
            {result.created.files > 0 && ` ${t("doneFiles", { count: result.created.files })}`}
          </p>
          {result.channels.length > 0 && (
            <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
              {result.channels.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => go(c.id)} className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-bg-hover">
                    {c.kind === "private" ? <Lock className="h-3.5 w-3.5 shrink-0 text-fg-icon" /> : <Hash className="h-3.5 w-3.5 shrink-0 text-fg-icon" />}
                    <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
                    <span className="shrink-0 text-xs text-fg-muted tabular-nums">{t("messageCount", { count: c.messages })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul className="list-disc space-y-1 ps-5 text-sm text-fg-muted">
              {result.warnings.map((w, i) => (
                <li key={i}>{warningText(t, w)}</li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={close}>
            {common("close")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={busy ? () => {} : close}>
      <form onSubmit={submit}>
        <DialogHeader title={t("title")} onClose={close} closeLabel={common("close")} />
        <DialogBody className="space-y-4">
          <p className="text-sm text-fg-muted">{t("intro")}</p>
          <div>
            <input
              ref={input}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(e) => {
                setChosen(e.target.files?.[0] ?? null);
                setError(null);
              }}
            />
            <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>
              <FileArchive className="h-4 w-4" />
              {chosen ? t("chooseAnother") : t("choose")}
            </Button>
            {chosen && (
              <span className="ms-3 text-sm text-fg">
                {chosen.name} <span className="text-fg-muted">· {formatBytes(chosen.size)}</span>
              </span>
            )}
          </div>
          <ul className="list-disc space-y-1 ps-5 text-sm text-fg-muted">
            <li>{t("howPeople")}</li>
            <li>{t("howChannels")}</li>
            <li>{t("howHistory")}</li>
          </ul>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-fg">{t("download")}</p>
              <p className="text-xs text-fg-muted">{t("downloadHint")}</p>
            </div>
            <Switch checked={download} onChange={setDownload} label={t("download")} />
          </div>
          {busy && <p className="text-sm text-fg-muted">{t("working")}</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {common("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!chosen || busy}>
            {busy ? t("importing") : t("import")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function warningText(t: ReturnType<typeof useTranslations<"messages.import">>, w: SlackImportWarning): string {
  switch (w.code) {
    case "renamed":
      return t("warnings.renamed", { from: w.from, to: w.to });
    case "alreadyImported":
      return t("warnings.alreadyImported", { name: w.name });
    case "unmatchedPeople":
      return t("warnings.unmatchedPeople", { count: w.count, names: w.names.join(", ") });
    case "reactionsLeftOut":
      return t("warnings.reactionsLeftOut", { count: w.count });
    case "directLeftOut":
      return t("warnings.directLeftOut", { count: w.count });
    case "repliesWithoutThread":
      return t("warnings.repliesWithoutThread", { count: w.count });
    case "filesAsLinks":
      return t("warnings.filesAsLinks", { count: w.count });
  }
}
