"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { cn, IconButton, Input } from "@/components/ui";
import { HTTP_METHODS, MAX_FOUND_ROWS, MAX_HTTP_BODY, MAX_HTTP_HEADERS, MAX_STEP_MESSAGE, MAX_WEBHOOK_URL, UNSETTABLE_TYPES, type HttpMethod } from "@/lib/automations";
import { pageLabel } from "@/lib/labels";
import { isSortable } from "@/lib/properties";
import { useAutomationWorkspace, useDatabaseInfo, useDatabaseList } from "./automations-data";
import { newKey, parseJson, type DraftActionOf, type Person, type WaitUnit } from "./automations-shared";
import { selectClass, ValuesEditor } from "./automations-values";
import { TemplateField } from "./automations-variables";
import { PeopleProvider } from "./person-cell";
import { RelationProvider } from "./relation-context";
import { columnsOf, FilterEditor, SortEditor } from "./view-bar";

/** Editors of the steps that reach outside the row: requests, finding rows, adding or changing rows elsewhere, waiting. */

function Label({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <span className="mb-1 flex items-baseline justify-between gap-2 text-xs text-fg-muted">
      {children}
      {hint && <span className="tabular-nums text-fg-faint">{hint}</span>}
    </span>
  );
}

/** A database of the workspace to work in; this one is offered first. */
export function DatabasePicker({ databaseId, value, onChange }: { databaseId: string; value: string; onChange: (id: string) => void }) {
  const t = useTranslations("database.automations.steps");
  const tc = useTranslations("common");
  const list = useDatabaseList();
  const own = list?.find((d) => d.id === databaseId);
  const others = (list ?? []).filter((d) => d.id !== databaseId);
  const known = !value || value === databaseId || others.some((d) => d.id === value);
  return (
    <label className="block">
      <Label>{t("database")}</Label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass} disabled={!list}>
        {!value && <option value="">{t("chooseDatabase")}</option>}
        <option value={databaseId}>{t("thisDatabase", { title: pageLabel(own?.title, tc("untitled")) })}</option>
        {others.map((d) => (
          <option key={d.id} value={d.id}>
            {d.icon ? `${d.icon} ` : ""}
            {pageLabel(d.title, tc("untitled"))}
          </option>
        ))}
        {list && !known && <option value={value}>{t("unknownDatabase")}</option>}
      </select>
    </label>
  );
}

/** An HTTP request: method, address, headers and a JSON body, all of which take variables. */
export function HttpRequestEditor({
  action,
  onChange,
}: {
  action: DraftActionOf<"http_request">;
  onChange: (action: DraftActionOf<"http_request">) => void;
}) {
  const t = useTranslations("database.automations.steps");
  const tc = useTranslations("common");
  const sendsBody = action.method !== "GET" && action.method !== "DELETE";
  const body = parseJson(action.body);
  const setHeader = (key: string, patch: Partial<{ name: string; value: string }>) =>
    onChange({ ...action, headers: action.headers.map((h) => (h.key === key ? { ...h, ...patch } : h)) });
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {/* Widths go on wrappers: the fields' own classes set w-full. */}
        <div className="w-24 shrink-0">
          <select
            value={action.method}
            aria-label={t("method")}
            onChange={(e) => onChange({ ...action, method: e.target.value as HttpMethod })}
            className={selectClass}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <TemplateField
            type="text"
            inputMode="url"
            dir="ltr"
            value={action.url}
            maxLength={MAX_WEBHOOK_URL}
            aria-label={t("url")}
            placeholder="https://api.example.com/orders/{{trigger.id}}"
            onChange={(url) => onChange({ ...action, url })}
          />
        </div>
      </div>
      <div>
        <Label>{t("headers")}</Label>
        {action.headers.length > 0 && (
          <ul className="mb-1.5 space-y-1.5">
            {action.headers.map((h) => (
              <li key={h.key} className="flex items-start gap-1.5">
                <div className="w-40 shrink-0">
                  <Input
                    value={h.name}
                    dir="ltr"
                    aria-label={t("headerName")}
                    placeholder={t("headerNamePlaceholder")}
                    onChange={(e) => setHeader(h.key, { name: e.target.value })}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <TemplateField
                    value={h.value}
                    dir="ltr"
                    maxLength={MAX_STEP_MESSAGE}
                    aria-label={t("headerValue")}
                    placeholder={t("headerValuePlaceholder")}
                    onChange={(value) => setHeader(h.key, { value })}
                  />
                </div>
                <IconButton
                  label={tc("remove")}
                  onClick={() => onChange({ ...action, headers: action.headers.filter((x) => x.key !== h.key) })}
                  className="mt-1 hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {action.headers.length < MAX_HTTP_HEADERS && (
          <button
            type="button"
            onClick={() => onChange({ ...action, headers: [...action.headers, { key: newKey(), name: "", value: "" }] })}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addHeader")}
          </button>
        )}
      </div>
      {sendsBody && (
        <div>
          <Label hint={`${action.body.length} / ${MAX_HTTP_BODY}`}>{t("body")}</Label>
          <TemplateField
            json
            rows={6}
            value={action.body}
            maxLength={MAX_HTTP_BODY}
            aria-label={t("body")}
            placeholder={'{\n  "name": "{{trigger.title}}"\n}'}
            onChange={(text) => onChange({ ...action, body: text })}
            className={cn("text-xs", !body.ok && "border-danger focus:border-danger")}
          />
          <p className={cn("mt-1 text-xs", body.ok ? "text-fg-faint" : "text-danger")} role={body.ok ? undefined : "alert"}>
            {body.ok ? t("bodyHelp") : t("bodyInvalid", { example: '"{{trigger.id}}"' })}
          </p>
        </div>
      )}
      <p className="text-xs text-fg-faint">{t("httpHelp", { template: `{{${action.id || "http"}.body}}` })}</p>
    </div>
  );
}

/** Rows of a database, by the filters and sorts a view has, at most a number of them. */
export function FindRowsEditor({
  databaseId,
  action,
  onChange,
}: {
  databaseId: string;
  action: DraftActionOf<"find_rows">;
  onChange: (action: DraftActionOf<"find_rows">) => void;
}) {
  const t = useTranslations("database.automations.steps");
  const tDb = useTranslations("database");
  const workspaceId = useAutomationWorkspace();
  const info = useDatabaseInfo(action.databaseId);
  const columns = useMemo(() => (info ? columnsOf(info.properties, tDb("nameColumn")) : []), [info, tDb]);
  const relationContext = useMemo(
    () =>
      info
        ? { workspaceId, databaseId: info.id, databaseTitle: info.title, targets: info.relations, createRow: async () => null }
        : null,
    [info, workspaceId],
  );
  const peopleContext = useMemo(() => ({ viewerId: info?.viewerId ?? null, people: info?.people ?? [] }), [info]);
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <DatabasePicker
            databaseId={databaseId}
            value={action.databaseId}
            // Another database's filters and sorts name its own properties.
            onChange={(id) => onChange({ ...action, databaseId: id, filters: [], sorts: [] })}
          />
        </div>
        <label className="block sm:w-28">
          <Label>{t("limit")}</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_FOUND_ROWS}
            value={action.limit}
            onChange={(e) => onChange({ ...action, limit: e.target.value })}
          />
        </label>
      </div>
      {info === null && <p className="text-xs text-danger">{t("databaseUnavailable")}</p>}
      {info && relationContext && (
        // The filters' value pickers read the found database's relations and people, not this one's.
        <RelationProvider value={relationContext}>
          <PeopleProvider value={peopleContext}>
              <div>
                <Label>{t("filters")}</Label>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <FilterEditor
                    key={info.id}
                    columns={columns}
                    filters={action.filters}
                    combinator={action.filterCombinator}
                    onChange={(filters, combinator) => onChange({ ...action, filters, filterCombinator: combinator })}
                  />
                </div>
              </div>
              <div>
                <Label>{t("sorts")}</Label>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <SortEditor
                    columns={columns.filter((c) => isSortable(c.type))}
                    sorts={action.sorts}
                    onChange={(sorts) => onChange({ ...action, sorts })}
                  />
                </div>
              </div>
          </PeopleProvider>
        </RelationProvider>
      )}
      <p className="text-xs text-fg-faint">{t("findHelp", { template: `{{${action.id || "find"}.rows}}`, max: MAX_FOUND_ROWS })}</p>
    </div>
  );
}

/** Adds a row to a database, or (upsert) changes the first one that matches and adds one when none does. */
export function RowWriteEditor({
  databaseId,
  action,
  people,
  noActor,
  onChange,
}: {
  databaseId: string;
  action: DraftActionOf<"create_row"> | DraftActionOf<"upsert_row">;
  people: Person[];
  noActor: boolean;
  onChange: (action: DraftActionOf<"create_row"> | DraftActionOf<"upsert_row">) => void;
}) {
  const t = useTranslations("database.automations.steps");
  const tDb = useTranslations("database");
  const info = useDatabaseInfo(action.databaseId);
  const matchable = (info?.properties ?? []).filter((p) => !(UNSETTABLE_TYPES as readonly string[]).includes(p.type));
  return (
    <div className="space-y-3">
      <DatabasePicker
        databaseId={databaseId}
        value={action.databaseId}
        // Values name the database's own properties.
        onChange={(id) =>
          onChange(action.type === "upsert_row" ? { ...action, databaseId: id, entries: [], matchProperty: "title" } : { ...action, databaseId: id, entries: [] })
        }
      />
      {info === null && <p className="text-xs text-danger">{t("databaseUnavailable")}</p>}
      {action.type === "upsert_row" && (
        <div>
          <Label>{t("match")}</Label>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
            <select
              value={action.matchProperty}
              aria-label={t("matchProperty")}
              onChange={(e) => onChange({ ...action, matchProperty: e.target.value })}
              className={cn(selectClass, "sm:w-44 sm:shrink-0")}
            >
              <option value="title">{tDb("nameColumn")}</option>
              {matchable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="flex h-8 shrink-0 items-center text-sm text-fg-muted">{t("equals")}</span>
            <div className="min-w-0 flex-1">
              <TemplateField
                value={action.matchValue}
                maxLength={MAX_STEP_MESSAGE}
                aria-label={t("matchValue")}
                placeholder="{{trigger.email}}"
                onChange={(matchValue) => onChange({ ...action, matchValue })}
              />
            </div>
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t("upsertHelp")}</p>
        </div>
      )}
      <label className="block">
        <Label>{t("rowTitle")}</Label>
        <TemplateField
          value={action.title}
          maxLength={MAX_STEP_MESSAGE}
          placeholder={t("rowTitlePlaceholder")}
          onChange={(title) => onChange({ ...action, title })}
        />
      </label>
      {info && (
        <div>
          <Label>{t("values")}</Label>
          <ValuesEditor
            entries={action.entries}
            properties={info.properties}
            people={people}
            noActor={noActor}
            onChange={(entries) => onChange({ ...action, entries })}
          />
        </div>
      )}
    </div>
  );
}

/** How long to wait before the next step, in minutes, hours or days (at most seven days). */
export function WaitEditor({ action, onChange }: { action: DraftActionOf<"wait">; onChange: (action: DraftActionOf<"wait">) => void }) {
  const t = useTranslations("database.automations.steps");
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <div className="w-24">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            value={action.amount}
            aria-label={t("waitAmount")}
            onChange={(e) => onChange({ ...action, amount: e.target.value })}
          />
        </div>
        <div className="w-36">
          <select
            value={action.unit}
            aria-label={t("waitUnit")}
            onChange={(e) => onChange({ ...action, unit: e.target.value as WaitUnit })}
            className={selectClass}
          >
            <option value="minutes">{t("units.minutes")}</option>
            <option value="hours">{t("units.hours")}</option>
            <option value="days">{t("units.days")}</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-fg-faint">{t("waitHelp")}</p>
    </div>
  );
}
