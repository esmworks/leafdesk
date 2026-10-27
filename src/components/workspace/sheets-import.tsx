"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { sheetsSourcesAction } from "@/app/actions/sheets-sync";
import { Input } from "@/components/ui";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { MAX_HEADER_ROW, MAX_SHEET_CELLS, parseSheetLink, type SheetsSource } from "@/lib/sheets-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a sheet sync up, once a connection and a link are given. */
export type SheetsSetup = {
  connectionId: string;
  link: string;
  headerRow: number | null;
  keyColumn: string;
  titleColumn: string;
  intervalMinutes: number;
  title: string;
};

/**
 * The import dialog's Google Sheets tab: the Google Sheets connection to read through (the ones
 * the person may use), a link to the sheet, the header row and the columns that find and name rows
 * (the sheet's own layout and its first column when left empty), how often to sync, and the
 * database's name and place. The sheet is read when the dialog submits. Tells the dialog the setup
 * (or null while it is incomplete) as it changes.
 */
export function SheetsTab({
  workspaceId,
  busy,
  destinationPicker,
  onSetup,
}: {
  workspaceId: string;
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: SheetsSetup | null) => void;
}) {
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const [sources, setSources] = useState<SheetsSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [link, setLink] = useState("");
  const [headerRow, setHeaderRow] = useState("");
  const [keyColumn, setKeyColumn] = useState("");
  const [titleColumn, setTitleColumn] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  useEffect(() => {
    let live = true;
    sheetsSourcesAction(workspaceId)
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setSources(result.data);
        setConnectionId(result.data[0]?.id ?? "");
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  const header = headerRow.trim() ? Number(headerRow) : null;
  const headerValid = header === null || (Number.isInteger(header) && header >= 1 && header <= MAX_HEADER_ROW);
  const linkValid = parseSheetLink(link) !== null;
  const valid = Boolean(connectionId) && linkValid && headerValid;
  useEffect(() => {
    onSetup(
      valid
        ? { connectionId, link: link.trim(), headerRow: header, keyColumn: keyColumn.trim(), titleColumn: titleColumn.trim(), intervalMinutes, title: name }
        : null,
    );
  }, [valid, connectionId, link, header, keyColumn, titleColumn, intervalMinutes, name, onSetup]);

  if (sources === null) {
    return error ? (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    ) : (
      <p className="text-sm text-fg-muted">{t("sheets.loading")}</p>
    );
  }
  if (!sources.length) {
    return (
      <div className="space-y-2 text-sm text-fg-muted">
        <p>{t("sheets.help", { limit: MAX_SHEET_CELLS })}</p>
        <p className="rounded-lg border border-border px-3 py-2">{t("sheets.noConnection")}</p>
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-fg-muted">{t("sheets.help", { limit: MAX_SHEET_CELLS })}</p>
      {sources.length > 1 ? (
        <label className="block">
          <span className={labelClass}>{t("sheets.connection")}</span>
          <select className={selectClass} value={connectionId} disabled={busy} onChange={(e) => setConnectionId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-fg-muted">{t("googleDocs.through", { name: sources[0].name })}</p>
      )}
      <label className="block">
        <span className={labelClass}>{t("sheets.link")}</span>
        <Input value={link} placeholder={t("sheets.linkPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setLink(e.target.value)} />
      </label>
      {link.trim() && !linkValid && (
        <p role="alert" className="text-xs text-danger">
          {t("sheets.invalidLink")}
        </p>
      )}
      <p className="text-xs text-fg-muted">{t("sheets.linkHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={labelClass}>{t("sheets.headerRow")}</span>
          <Input
            type="number"
            min={1}
            max={MAX_HEADER_ROW}
            value={headerRow}
            placeholder={t("sheets.headerRowPlaceholder")}
            disabled={busy}
            aria-invalid={!headerValid}
            onChange={(e) => setHeaderRow(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={labelClass}>{t("postgres.key")}</span>
          <Input value={keyColumn} placeholder={t("sheets.keyPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setKeyColumn(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("postgres.titleColumn")}</span>
          <Input value={titleColumn} placeholder={t("sheets.titlePlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setTitleColumn(e.target.value)} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={t("sheets.namePlaceholder")} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.every")}</span>
          <select className={selectClass} value={intervalMinutes} disabled={busy} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
            {JIRA_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t(`jira.intervals.${jiraIntervalKey(minutes)}`)}
              </option>
            ))}
          </select>
        </label>
        {destinationPicker}
      </div>
    </>
  );
}
