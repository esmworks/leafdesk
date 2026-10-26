"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { MAX_POSTGRES_ROWS, parsePostgresUrl, parseTableName } from "@/lib/postgres-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a table sync up, once the address and table are named. */
export type PostgresSetup = { url: string; table: string; keyColumn: string; titleColumn: string; intervalMinutes: number; title: string };

/**
 * The import dialog's PostgreSQL tab: the connection address (with user and password), the table,
 * the columns that find and name rows (the primary key and the first text column when left
 * empty), how often to sync, and the database's name and place. The table is read when the dialog
 * submits. Tells the dialog the setup (or null while it is incomplete) as it changes.
 */
export function PostgresTab({
  busy,
  destinationPicker,
  onSetup,
}: {
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: PostgresSetup | null) => void;
}) {
  const t = useTranslations("import");
  const [url, setUrl] = useState("");
  const [table, setTable] = useState("");
  const [keyColumn, setKeyColumn] = useState("");
  const [titleColumn, setTitleColumn] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  const valid = parsePostgresUrl(url) !== null && parseTableName(table) !== null;
  useEffect(() => {
    onSetup(valid ? { url: url.trim(), table: table.trim(), keyColumn: keyColumn.trim(), titleColumn: titleColumn.trim(), intervalMinutes, title: name } : null);
  }, [valid, url, table, keyColumn, titleColumn, intervalMinutes, name, onSetup]);

  return (
    <>
      <p className="text-sm text-fg-muted">{t("postgres.help", { limit: MAX_POSTGRES_ROWS })}</p>
      <label className="block">
        <span className={labelClass}>{t("postgres.url")}</span>
        <Input type="password" value={url} placeholder={t("postgres.urlPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="text-xs text-fg-muted">{t("postgres.urlHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={labelClass}>{t("postgres.table")}</span>
          <Input value={table} placeholder={t("postgres.tablePlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setTable(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("postgres.key")}</span>
          <Input value={keyColumn} placeholder={t("postgres.keyPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setKeyColumn(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("postgres.titleColumn")}</span>
          <Input value={titleColumn} placeholder={t("postgres.titlePlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setTitleColumn(e.target.value)} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={parseTableName(table)?.table ?? ""} disabled={busy} onChange={(e) => setName(e.target.value)} />
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
