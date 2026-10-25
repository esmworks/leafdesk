"use client";

import { iconPrefix } from "@/lib/icon-value";
import { IconGlyph } from "@/components/builtin-icon";
import { ArrowDown, ArrowUp, Copy, FileText, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { buttonSettingsAction } from "@/app/actions/buttons";
import { Button, cn, Dialog, IconButton, Input, Switch } from "@/components/ui";
import { DatabasesProvider, useAutomationWorkspace, useDatabaseInfo, useDatabaseList } from "@/components/database/automations-data";
import { newKey, valuesOf, type Person, type SetEntry } from "@/components/database/automations-shared";
import { PeoplePicker, selectClass, ValuesEditor } from "@/components/database/automations-values";
import { TemplateField, VariablesProvider, type VariableGroup } from "@/components/database/automations-variables";
import { RowTemplateSelect } from "@/components/database/row-template-select";
import { PeopleProvider } from "@/components/database/person-cell";
import { RelationProvider } from "@/components/database/relation-context";
import { columnsOf, FilterEditor } from "@/components/database/view-bar";
import type { FilterCombinator, FilterEntry } from "@/db/schema/app";
import { MAX_STEP_MESSAGE, MAX_WEBHOOK_URL } from "@/lib/automations";
import {
  BUTTON_COLORS,
  BUTTON_STEP_TYPES,
  buttonColor,
  cleanButtonLabel,
  INSERT_PLACES,
  MAX_BUTTON_LABEL,
  MAX_BUTTON_ROWS,
  MAX_BUTTON_STEPS,
  MAX_INSERT_MARKDOWN,
  parseButtonConfig,
  serializeButtonConfig,
  type ButtonColor,
  type ButtonStep,
  type ButtonStepType,
  type InsertPlace,
} from "@/lib/buttons";
import { parseImageLink } from "@/lib/image-links";
import { pageLabel } from "@/lib/labels";
import { pagePath } from "@/lib/mentions";
import { IconPicker } from "./icon-picker";
import { loadedPageTitle, PagePicker } from "./mentions";
import type { PageEditor } from "./embed-blocks";

/**
 * A button's settings (lib/buttons.ts): its label, emoji and color, whether it asks first, and its steps
 * in order. Loaded only when someone who may edit the page opens them; saved into the block's
 * props, so they sync, undo and version with the page.
 */

type DraftStep = { key: string } & (
  | { type: "insert"; at: InsertPlace; markdown: string }
  | { type: "add_row"; databaseId: string; title: string; entries: SetEntry[]; template: string }
  | { type: "update_rows"; databaseId: string; filters: FilterEntry[]; filterCombinator: FilterCombinator; entries: SetEntry[] }
  | { type: "notify"; userIds: string[]; message: string }
  | { type: "webhook"; url: string }
  | { type: "open"; target: string }
);
type DraftOf<T extends ButtonStepType> = Extract<DraftStep, { type: T }>;

const entriesOf = (values: Record<string, unknown>): SetEntry[] => Object.entries(values).map(([propertyId, value]) => ({ propertyId, value }));

function toDraft(step: ButtonStep): DraftStep {
  const key = newKey();
  switch (step.type) {
    case "add_row":
      return { key, type: "add_row", databaseId: step.databaseId, title: step.title, entries: entriesOf(step.values), template: step.template ?? "" };
    case "update_rows":
      return { key, type: "update_rows", databaseId: step.databaseId, filters: step.filters, filterCombinator: step.filterCombinator, entries: entriesOf(step.values) };
    default:
      return { key, ...step };
  }
}

function newStep(type: ButtonStepType): DraftStep {
  const key = newKey();
  switch (type) {
    case "insert":
      return { key, type, at: "below", markdown: "" };
    case "add_row":
      return { key, type, databaseId: "", title: "", entries: [], template: "" };
    case "update_rows":
      return { key, type, databaseId: "", filters: [], filterCombinator: "and", entries: [] };
    case "notify":
      return { key, type, userIds: [], message: "" };
    case "webhook":
      return { key, type, url: "" };
    case "open":
      return { key, type, target: "" };
  }
}

type SchemaOf = (databaseId: string) => Parameters<typeof valuesOf>[1];

function toStep(step: DraftStep, schemaOf: SchemaOf): ButtonStep {
  switch (step.type) {
    case "add_row":
      return {
        type: "add_row",
        databaseId: step.databaseId,
        title: step.title,
        values: valuesOf(step.entries, schemaOf(step.databaseId)),
        ...(step.template ? { template: step.template } : {}),
      };
    case "update_rows":
      return {
        type: "update_rows",
        databaseId: step.databaseId,
        filters: step.filters,
        filterCombinator: step.filterCombinator,
        values: valuesOf(step.entries, schemaOf(step.databaseId)),
      };
    default: {
      const { key: _key, ...rest } = step;
      return rest;
    }
  }
}

export default function ButtonSettings({
  editor,
  blockId,
  workspaceId,
  pageId,
  onClose,
}: {
  editor: PageEditor;
  blockId: string;
  workspaceId: string;
  pageId: string;
  onClose: () => void;
}) {
  return (
    <DatabasesProvider workspaceId={workspaceId}>
      <SettingsDialog editor={editor} blockId={blockId} pageId={pageId} onClose={onClose} />
    </DatabasesProvider>
  );
}

function SettingsDialog({ editor, blockId, pageId, onClose }: { editor: PageEditor; blockId: string; pageId: string; onClose: () => void }) {
  const t = useTranslations("page.button");
  const tc = useTranslations("common");
  const tColor = useTranslations("database.colors");
  const [initial] = useState(() => {
    const props = (editor.getBlock(blockId)?.props ?? {}) as { label?: unknown; icon?: unknown; config?: unknown; color?: unknown };
    const config = parseButtonConfig(props.config);
    return {
      label: cleanButtonLabel(props.label),
      icon: typeof props.icon === "string" ? props.icon : "",
      color: buttonColor(props.color),
      confirm: config.confirm,
      steps: config.steps.map(toDraft),
    };
  });
  const [label, setLabel] = useState(initial.label);
  const [icon, setIcon] = useState(initial.icon);
  const [color, setColor] = useState<ButtonColor | null>(initial.color);
  const [confirm, setConfirm] = useState(initial.confirm);
  const [steps, setSteps] = useState<DraftStep[]>(initial.steps);
  const [settings, setSettings] = useState<{ secret: string; people: Person[] } | null>(null);
  const [schemas, setSchemas] = useState<Record<string, Parameters<typeof valuesOf>[1]>>({});

  useEffect(() => {
    let live = true;
    buttonSettingsAction(pageId, blockId)
      .then((res) => live && res.ok && setSettings(res.data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pageId, blockId]);

  const variables = useMemo<VariableGroup[]>(
    () => [
      {
        label: t("variables.group"),
        items: [
          { label: t("variables.today"), template: "{{today}}" },
          { label: t("variables.now"), template: "{{now}}" },
          { label: t("variables.me"), template: "{{me}}" },
        ],
      },
    ],
    [t],
  );

  const setStep = (index: number, step: DraftStep) => setSteps((all) => all.map((s, i) => (i === index ? step : s)));
  const move = (index: number, by: number) =>
    setSteps((all) => {
      const next = [...all];
      const [step] = next.splice(index, 1);
      next.splice(index + by, 0, step);
      return next;
    });

  const save = () => {
    if (editor.getBlock(blockId)) {
      const config = serializeButtonConfig({ confirm, steps: steps.map((s) => toStep(s, (id) => schemas[id])) });
      editor.updateBlock(blockId, { props: { label: cleanButtonLabel(label), icon, config, color: color ?? "" } });
    }
    onClose();
  };

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <form
        className="flex max-h-[76vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-4 overflow-y-auto p-4">
          <h2 className="text-sm font-semibold">{t("settings.open")}</h2>
          <div className="flex items-end gap-2">
            <IconPicker icon={icon || null} onChange={(next) => setIcon(next ?? "")}>
              {(toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={t("settings.icon")}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-lg hover:bg-bg-hover"
                >
                  {icon ? <IconGlyph icon={icon} /> : <span className="text-sm text-fg-faint">+</span>}
                </button>
              )}
            </IconPicker>
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-xs text-fg-muted">{t("settings.label")}</span>
              <Input autoFocus value={label} maxLength={MAX_BUTTON_LABEL} placeholder={t("placeholder")} onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>
          <div>
            <span id={`button-color-${blockId}`} className="mb-1 block text-xs text-fg-muted">
              {t("settings.color")}
            </span>
            <div role="radiogroup" aria-labelledby={`button-color-${blockId}`} className="flex flex-wrap gap-1.5">
              {[null, ...BUTTON_COLORS].map((option) => {
                const name = option ? tColor(option) : t("settings.colorDefault");
                return (
                  <button
                    key={option ?? "default"}
                    type="button"
                    role="radio"
                    aria-checked={option === color}
                    aria-label={name}
                    title={name}
                    onClick={() => setColor(option)}
                    className={cn(
                      "h-6 w-6 rounded-md border",
                      option ? `opt-${option} border-transparent high-contrast:border-(--opt-fg)` : "border-border bg-bg",
                      option === color ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:ring-1 hover:ring-border",
                    )}
                  />
                );
              })}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("settings.confirm")}
              <span className="block text-xs text-fg-muted">{t("settings.confirmHelp")}</span>
            </span>
            <Switch checked={confirm} onChange={setConfirm} label={t("settings.confirm")} />
          </label>
          <div>
            <h3 className="mb-1 text-xs font-medium text-fg-muted">{t("settings.steps")}</h3>
            <p className="mb-2 text-xs text-fg-faint">{t("settings.stepsHelp")}</p>
            <VariablesProvider value={variables}>
              <ol className="space-y-2">
                {steps.map((step, index) => (
                  <li key={step.key} className="rounded-lg border border-border p-3">
                    <div className="mb-2 flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {index + 1}. {t(`steps.${step.type}`)}
                      </span>
                      <IconButton label={t("settings.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label={t("settings.moveDown")} disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label={tc("remove")} onClick={() => setSteps((all) => all.filter((_, i) => i !== index))} className="hover:text-danger">
                        <X className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                    <StepEditor
                      step={step}
                      pageId={pageId}
                      settings={settings}
                      onSchema={(id, props) => setSchemas((all) => (all[id] === props ? all : { ...all, [id]: props }))}
                      onChange={(next) => setStep(index, next)}
                    />
                  </li>
                ))}
              </ol>
            </VariablesProvider>
            {steps.length < MAX_BUTTON_STEPS && (
              <select
                value=""
                aria-label={t("settings.addStep")}
                onChange={(e) => {
                  const type = BUTTON_STEP_TYPES.find((s) => s === e.target.value);
                  if (type) setSteps((all) => [...all, newStep(type)]);
                }}
                className="mt-2 h-8 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
              >
                <option value="">+ {t("settings.addStep")}</option>
                {BUTTON_STEP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`steps.${type}`)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {tc("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

function StepEditor({
  step,
  pageId,
  settings,
  onSchema,
  onChange,
}: {
  step: DraftStep;
  pageId: string;
  settings: { secret: string; people: Person[] } | null;
  onSchema: (databaseId: string, properties: Parameters<typeof valuesOf>[1]) => void;
  onChange: (step: DraftStep) => void;
}) {
  const t = useTranslations("page.button.settings");
  switch (step.type) {
    case "insert":
      return (
        <div className="space-y-2">
          <Field label={t("insertAt")}>
            <select value={step.at} onChange={(e) => onChange({ ...step, at: e.target.value as InsertPlace })} className={selectClass}>
              {INSERT_PLACES.map((at) => (
                <option key={at} value={at}>
                  {t(`at.${at}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("markdown")}>
            <TemplateField
              rows={5}
              value={step.markdown}
              maxLength={MAX_INSERT_MARKDOWN}
              aria-label={t("markdown")}
              onChange={(markdown) => onChange({ ...step, markdown })}
            />
          </Field>
        </div>
      );
    case "add_row":
    case "update_rows":
      return <RowStepEditor step={step} people={settings?.people ?? []} onSchema={onSchema} onChange={onChange} />;
    case "notify":
      return (
        <div className="space-y-2">
          <Field label={t("people")}>
            <PeoplePicker people={settings?.people ?? []} selected={step.userIds} onChange={(userIds) => onChange({ ...step, userIds })} />
          </Field>
          <Field label={t("message")}>
            <TemplateField
              rows={2}
              value={step.message}
              maxLength={MAX_STEP_MESSAGE}
              aria-label={t("message")}
              onChange={(message) => onChange({ ...step, message })}
            />
          </Field>
          <p className="text-xs text-fg-faint">{t("notifyHelp")}</p>
        </div>
      );
    case "webhook":
      return (
        <div className="space-y-2">
          <Field label={t("url")}>
            <Input value={step.url} maxLength={MAX_WEBHOOK_URL} placeholder="https://" dir="ltr" onChange={(e) => onChange({ ...step, url: e.target.value })} />
          </Field>
          {settings && <Secret secret={settings.secret} />}
          <p className="text-xs text-fg-faint">{t("webhookHelp")}</p>
        </div>
      );
    case "open":
      return <OpenEditor step={step} pageId={pageId} onChange={onChange} />;
  }
}

/** The signing secret, to copy into whatever receives the webhooks. */
function Secret({ secret }: { secret: string }) {
  const t = useTranslations("page.button.settings");
  return (
    <Field label={t("secret")}>
      <div className="flex items-center gap-1.5">
        <Input readOnly value={secret} dir="ltr" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <IconButton
          label={t("copySecret")}
          onClick={() => void navigator.clipboard?.writeText(secret)}
          className="h-8 w-8 border border-border"
        >
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </Field>
  );
}

function OpenEditor({ step, pageId, onChange }: { step: DraftOf<"open">; pageId: string; onChange: (step: DraftStep) => void }) {
  const t = useTranslations("page.button.settings");
  const tc = useTranslations("common");
  const tf = useTranslations("page.button.failed");
  const workspaceId = useAutomationWorkspace();
  const [picking, setPicking] = useState(false);
  const link = step.target.trim() ? parseImageLink(step.target, typeof window === "undefined" ? undefined : window.location.origin) : null;
  return (
    <div className="space-y-2">
      <Field label={t("target")}>
        <div className="flex items-center gap-1.5">
          <Input
            value={step.target}
            maxLength={MAX_WEBHOOK_URL}
            placeholder="https://"
            dir="ltr"
            aria-invalid={(step.target.trim() !== "" && !link) || undefined}
            onChange={(e) => onChange({ ...step, target: e.target.value })}
          />
          <Button type="button" size="sm" onClick={() => setPicking(true)}>
            {t("pickPage")}
          </Button>
        </div>
      </Field>
      {link?.kind === "page" && (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("toPage", { title: loadedPageTitle(link.pageId) ?? tc("untitled") })}
        </p>
      )}
      {step.target.trim() !== "" && !link && <p className="text-xs text-danger">{tf("invalidTarget")}</p>}
      <PagePicker
        open={picking}
        pageId={pageId}
        title={t("pickPage")}
        onClose={() => setPicking(false)}
        onPick={(target) => {
          setPicking(false);
          onChange({ ...step, target: pagePath(workspaceId, target) });
        }}
      />
    </div>
  );
}

/** Adds a row to a database, or changes the rows of one that the filters match. */
function RowStepEditor({
  step,
  people,
  onSchema,
  onChange,
}: {
  step: DraftOf<"add_row"> | DraftOf<"update_rows">;
  people: Person[];
  onSchema: (databaseId: string, properties: Parameters<typeof valuesOf>[1]) => void;
  onChange: (step: DraftStep) => void;
}) {
  const t = useTranslations("page.button.settings");
  const ts = useTranslations("database.automations.steps");
  const tDb = useTranslations("database");
  const tc = useTranslations("common");
  const workspaceId = useAutomationWorkspace();
  const list = useDatabaseList();
  const info = useDatabaseInfo(step.databaseId || null);
  useEffect(() => {
    if (info) onSchema(info.id, info.properties);
  }, [info, onSchema]);
  const columns = useMemo(() => (info ? columnsOf(info.properties, tDb("nameColumn")) : []), [info, tDb]);
  const relationContext = useMemo(
    () => (info ? { workspaceId, databaseId: info.id, databaseTitle: info.title, targets: info.relations, createRow: async () => null } : null),
    [info, workspaceId],
  );
  const peopleContext = useMemo(() => ({ viewerId: info?.viewerId ?? null, people: info?.people ?? [] }), [info]);
  const known = !step.databaseId || (list ?? []).some((d) => d.id === step.databaseId);
  return (
    <div className="space-y-2">
      <Field label={ts("database")}>
        <select
          value={step.databaseId}
          disabled={!list}
          // Values and filters name the database's own properties.
          onChange={(e) =>
            onChange(
              step.type === "add_row"
                ? { ...step, databaseId: e.target.value, entries: [], template: "" }
                : { ...step, databaseId: e.target.value, entries: [], filters: [] },
            )
          }
          className={selectClass}
        >
          {!step.databaseId && <option value="">{ts("chooseDatabase")}</option>}
          {(list ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {iconPrefix(d.icon)}
              {pageLabel(d.title, tc("untitled"))}
            </option>
          ))}
          {list && !known && <option value={step.databaseId}>{ts("unknownDatabase")}</option>}
        </select>
      </Field>
      {info === null && <p className="text-xs text-danger">{ts("databaseUnavailable")}</p>}
      {info && step.type === "add_row" && (
        <>
          <Field label={ts("rowTemplate")}>
            <RowTemplateSelect info={info} value={step.template} onChange={(template) => onChange({ ...step, template })} />
          </Field>
          <Field label={t("rowTitle")}>
            <TemplateField value={step.title} maxLength={MAX_STEP_MESSAGE} aria-label={t("rowTitle")} onChange={(title) => onChange({ ...step, title })} />
          </Field>
          {step.template && <p className="text-xs text-fg-faint">{ts("rowTemplateHelp")}</p>}
        </>
      )}
      {info && step.type === "update_rows" && relationContext && (
        <RelationProvider value={relationContext}>
          <PeopleProvider value={peopleContext}>
            <Field label={ts("filters")}>
              <div className="overflow-x-auto rounded-lg border border-border">
                <FilterEditor
                  key={info.id}
                  columns={columns}
                  filters={step.filters}
                  combinator={step.filterCombinator}
                  onChange={(filters, filterCombinator) => onChange({ ...step, filters, filterCombinator })}
                />
              </div>
            </Field>
          </PeopleProvider>
        </RelationProvider>
      )}
      {info && (
        <Field label={t("values")}>
          <ValuesEditor
            entries={step.entries}
            properties={info.properties}
            people={people.length ? people : info.people.map((p) => ({ id: p.id, name: p.name, email: p.email ?? null, image: p.image }))}
            noActor={false}
            onChange={(entries) => onChange({ ...step, entries })}
          />
        </Field>
      )}
      {info && step.type === "update_rows" && <p className={cn("text-xs text-fg-faint")}>{t("updateHelp", { max: MAX_BUTTON_ROWS })}</p>}
    </div>
  );
}
