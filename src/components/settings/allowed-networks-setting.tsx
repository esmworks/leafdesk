"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { setAllowedNetworksAction } from "@/app/actions/workspaces";
import { Button, IconButton, Input } from "@/components/ui";
import { ipAllowed, parseNetwork, type AllowedNetwork } from "@/lib/ip-allowlist";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

type Row = { key: number; range: string; label: string };

let nextKey = 0;
const rowsOf = (networks: AllowedNetwork[]): Row[] => networks.map((n) => ({ key: nextKey++, ...n }));
const comparable = (rows: Pick<Row, "range" | "label">[]) =>
  JSON.stringify(rows.filter((r) => r.range.trim() || r.label.trim()).map((r) => [r.range.trim(), r.label.trim()]));

/**
 * Settings > Security: the approved networks, edited as rows of an address or range and a label.
 * The server makes them canonical and refuses a list that leaves out the owner's own address
 * (`clientIp`, as the server sees it); the form says so before saving too.
 */
export function AllowedNetworksSetting({
  workspaceId,
  networks,
  clientIp,
}: {
  workspaceId: string;
  networks: AllowedNetwork[];
  /** The owner's address as the server sees it, canonical; null when it can't tell. */
  clientIp: string | null;
}) {
  const t = useTranslations("settings.security.allowedNetworks");
  const tc = useTranslations("common");
  const id = useId();
  const [saved, setSaved] = useState(networks);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(networks));
  const [justSaved, setJustSaved] = useState(false);
  const { pending, error, run } = useAction();

  const filled = rows.filter((r) => r.range.trim());
  const readable = filled.filter((r) => parseNetwork(r.range).ok);
  const dirty = comparable(rows) !== comparable(saved);
  const covered = clientIp !== null && readable.length > 0 && ipAllowed(clientIp, readable);
  const update = (key: number, patch: Partial<Row>) => {
    setJustSaved(false);
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const add = (range = "", label = "") => {
    setJustSaved(false);
    setRows((current) => [...current.filter((r) => r.range.trim() || r.label.trim()), { key: nextKey++, range, label }]);
  };

  let status: string;
  if (filled.length === 0) status = t("empty");
  else if (clientIp === null) status = t("addressUnknown");
  else if (covered) status = t("yourAddressOnList", { ip: clientIp });
  else status = t("yourAddressMissing", { ip: clientIp });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        setJustSaved(false);
        run(
          () => setAllowedNetworksAction(workspaceId, rows.map(({ range, label }) => ({ range, label }))),
          (list) => {
            setSaved(list);
            setRows(rowsOf(list));
            setJustSaved(true);
          },
        );
      }}
    >
      <SettingsRow
        title={t("title")}
        description={
          <>
            {t("description")} {t("appsNote")}
          </>
        }
      >
        <div className="space-y-3">
          {rows.length > 0 && (
            <div className="space-y-2" role="list" aria-label={t("title")}>
              <div className="hidden gap-2 text-xs font-medium text-fg-muted sm:flex" aria-hidden>
                <span className="flex-[3]">{t("range")}</span>
                <span className="flex-[2]">{t("label")}</span>
                <span className="w-6" />
              </div>
              {rows.map((row, index) => (
                <div key={row.key} role="listitem" className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    id={`${id}-range-${index}`}
                    aria-label={t("range")}
                    value={row.range}
                    placeholder={t("rangePlaceholder")}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="w-full sm:flex-[3]"
                    aria-invalid={row.range.trim() !== "" && !parseNetwork(row.range).ok}
                    onChange={(e) => update(row.key, { range: e.target.value })}
                  />
                  <div className="flex items-center gap-2 sm:flex-[2]">
                    <Input
                      aria-label={t("label")}
                      value={row.label}
                      placeholder={t("labelPlaceholder")}
                      maxLength={100}
                      className="w-full"
                      onChange={(e) => update(row.key, { label: e.target.value })}
                    />
                    <IconButton
                      label={row.range.trim() ? t("remove", { range: row.range.trim() }) : t("removeRow")}
                      onClick={() => {
                        setJustSaved(false);
                        setRows((current) => current.filter((r) => r.key !== row.key));
                      }}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className={error ? "text-sm text-danger" : "text-sm text-fg-muted"} role={error ? "alert" : undefined} data-networks-status>
            {error ?? (justSaved ? `${tc("saved")} ${status}` : status)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="gap-1.5" onClick={() => add()}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("add")}
            </Button>
            {clientIp && !covered && (
              <Button type="button" size="sm" onClick={() => add(clientIp)}>
                {t("addMine", { ip: clientIp })}
              </Button>
            )}
            <div className="flex-1" />
            <Button type="submit" variant="primary" size="sm" disabled={!dirty || pending}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">{t("lockoutHelp")}</p>
        </div>
      </SettingsRow>
    </form>
  );
}

/** What members see: whether the workspace only opens from approved networks, without the list. */
export function AllowedNetworksSummary({ count }: { count: number }) {
  const t = useTranslations("settings.security.allowedNetworks");
  const ts = useTranslations("settings.security");
  return (
    <SettingsRow
      title={t("title")}
      description={
        <>
          {t("memberView", { count })} {t("appsNote")} {ts("ownersOnly")}
        </>
      }
    />
  );
}
