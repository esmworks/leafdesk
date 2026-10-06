"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Bot,
  BotOff,
  Calculator,
  Check,
  ChevronRight,
  Combine,
  EyeOff,
  ListFilter,
  Lock,
  Plus,
  RefreshCw,
  Rows3,
  Settings2,
  Sigma,
  Trash2,
  Ungroup,
  WrapText,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, cn, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { isComputed, isDerived, PROPERTY_TYPES, STATUS_GROUPS, type StatusGroup } from "@/lib/property-types";
import { pageLabel } from "@/lib/labels";
import { canRestrict } from "@/lib/property-access";
import { SELECT_COLORS, sortStatusOptions, statusColor, statusGroupOf } from "@/lib/properties";
import type { AiAutofillConfig } from "@/lib/ai";
import type { AggregateFn } from "@/lib/aggregate";
import { AutofillEditor } from "./ai-autofill";
import { FormulaEditor } from "./formula-editor";
import { RollupEditor } from "./rollup-editor";
import { CalculationOptions } from "./table-calculations";
import { OptionChip } from "./property-cell";
import { PropertyTypeIcon, usePropertyTypeLabel } from "./property-icons";
import { RelationSetup } from "./relation-cell";
import { useRelations } from "./relation-context";
import type { DerivedInput, Property, PropertyType, RelationInput, RollupInput, SelectOption } from "./types";

/** Name + type picker used by the table "+" header and the row page "Add property". */
export function AddPropertyPanel({
  onCreate,
  onCreateAutofill,
  onDone,
}: {
  onCreate: (name: string, type: PropertyType, relation?: RelationInput, derived?: DerivedInput) => void | Promise<unknown>;
  /** Adds a text property that AI fills in (see ai-autofill.tsx); omitted when AI isn't available. */
  onCreateAutofill?: (name: string, config: AiAutofillConfig) => void | Promise<unknown>;
  onDone: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const ta = useTranslations("ai.autofill");
  const typeLabel = usePropertyTypeLabel();
  const [name, setName] = useState("");
  const [step, setStep] = useState<"type" | "relation" | "formula" | "rollup" | "autofill">("type");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // A new property without a name is named after its type, in the user's language.
  const nameFor = (type: PropertyType) => name.trim() || typeLabel(type);
  const create = (type: PropertyType) => {
    if (type === "relation" || type === "formula" || type === "rollup") {
      setStep(type);
      return;
    }
    void onCreate(nameFor(type), type);
    onDone();
  };
  if (step === "autofill" && onCreateAutofill) {
    return (
      <AutofillEditor
        prop={null}
        name={name.trim()}
        onBack={() => setStep("type")}
        onSave={(config) => {
          void onCreateAutofill(name.trim() || ta(`defaultNames.${config.mode}`), config);
          onDone();
        }}
      />
    );
  }
  if (step === "formula") {
    return (
      <FormulaEditor
        prop={null}
        name={nameFor("formula")}
        onBack={() => setStep("type")}
        onSave={(expression) => {
          void onCreate(nameFor("formula"), "formula", undefined, { formula: { expression } });
          onDone();
        }}
      />
    );
  }
  if (step === "rollup") {
    return (
      <RollupEditor
        prop={null}
        name={nameFor("rollup")}
        onBack={() => setStep("type")}
        onSave={(rollup) => {
          void onCreate(nameFor("rollup"), "rollup", undefined, { rollup });
          onDone();
        }}
      />
    );
  }
  if (step === "relation") {
    return (
      <RelationSetup
        name={nameFor("relation")}
        onBack={() => setStep("type")}
        onCreate={(relation) => {
          void onCreate(nameFor("relation"), "relation", relation);
          onDone();
        }}
      />
    );
  }
  return (
    <div className="w-60">
      <div className="p-1">
        <Input
          ref={input}
          value={name}
          placeholder={t("name")}
          aria-label={t("name")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create("text")}
          className="h-7"
        />
      </div>
      <div className="px-2 pt-1.5 pb-1 text-xs text-fg-muted">{t("type")}</div>
      {PROPERTY_TYPES.map((type) => (
        <MenuItem key={type} icon={<PropertyTypeIcon type={type} />} onClick={() => create(type)}>
          {typeLabel(type)}
        </MenuItem>
      ))}
      {onCreateAutofill && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Bot className="h-3.5 w-3.5" />} onClick={() => setStep("autofill")}>
            {ta("addEntry")}
          </MenuItem>
        </>
      )}
    </div>
  );
}

export type PropertyMenuActions = {
  /** Omitted when the name can't change (Name column, locked database). */
  rename?: (name: string) => void;
  /** Adds a filter on the column and opens the view's filters. */
  filter?: () => void;
  /** Omitted for properties that can't be sorted (relations). */
  sort?: (direction: "asc" | "desc") => void;
  /** Groups the table by the property; `ungroup` instead while it already does. */
  group?: () => void;
  ungroup?: () => void;
  /** The column's footer calculation: the type it calculates as, the current one and how to change it. */
  calculation?: { type: string; fn: string | undefined; onChange: (fn: AggregateFn | null) => void };
  hide?: () => void;
  /** Turns wrapping the column's cells onto more lines on and off; `wrapped` says whether it is on. */
  toggleWrap?: () => void;
  wrapped?: boolean;
  /** Adds a property left ("before") or right ("after") of the column, on the sides listed. */
  insert?: {
    sides: ("before" | "after")[];
    onCreate: (side: "before" | "after", ...args: Parameters<React.ComponentProps<typeof AddPropertyPanel>["onCreate"]>) => void | Promise<unknown>;
    onCreateAutofill?: (side: "before" | "after", name: string, config: AiAutofillConfig) => void | Promise<unknown>;
  };
  setOptions?: (options: SelectOption[]) => void;
  /** Formulas: saves a new expression (with property ids, see FormulaEditor). */
  setFormula?: (expression: string) => void;
  /** Rollups: saves new settings. */
  setRollup?: (rollup: RollupInput) => void;
  /** Text properties, when AI is available: turns AI autofill on, changes it or (null) turns it off. */
  setAutofill?: (config: AiAutofillConfig | null) => void;
  /** Autofill properties: works the values of the view's rows out again. */
  updateAllAutofill?: () => void;
  /** Full access to the database: opens the property's access settings. */
  openAccess?: () => void;
  remove?: () => void;
};

export function PropertyMenu({
  prop,
  actions,
  onDone,
}: {
  prop: Property | null;
  actions: PropertyMenuActions;
  onDone: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const tc = useTranslations("common");
  const typeLabel = usePropertyTypeLabel();
  const ta = useTranslations("ai.autofill");
  const tAccess = useTranslations("database.propertyAccess");
  const [page, setPage] = useState<
    "main" | "options" | "confirm" | "formula" | "rollup" | "autofill" | "calculate" | "insert-before" | "insert-after"
  >("main");
  const [name, setName] = useState(prop?.name ?? "");
  const saved = useRef(prop?.name ?? "");
  const commitName = () => {
    const next = name.trim();
    if (prop && actions.rename && next && next !== saved.current) {
      saved.current = next;
      actions.rename(next);
    }
  };
  // Closing the menu by clicking outside unmounts it before the input's blur fires.
  const commitRef = useRef(commitName);
  commitRef.current = commitName;
  useEffect(() => () => commitRef.current(), []);
  // Runs an action and closes the menu.
  const run = (action: (() => void) | undefined) => () => {
    action?.();
    onDone();
  };

  if (page === "options" && prop && actions.setOptions) {
    return <OptionsEditor prop={prop} onChange={actions.setOptions} onBack={() => setPage("main")} />;
  }

  if (page === "formula" && prop && actions.setFormula) {
    return (
      <FormulaEditor
        prop={prop}
        name={prop.name}
        onBack={() => setPage("main")}
        onSave={(expression) => {
          actions.setFormula?.(expression);
          onDone();
        }}
      />
    );
  }

  if (page === "rollup" && prop && actions.setRollup) {
    return (
      <RollupEditor
        prop={prop}
        name={prop.name}
        onBack={() => setPage("main")}
        onSave={(rollup) => {
          actions.setRollup?.(rollup);
          onDone();
        }}
      />
    );
  }

  if (page === "autofill" && prop && actions.setAutofill) {
    return (
      <AutofillEditor
        prop={prop}
        name={prop.name}
        onBack={() => setPage("main")}
        onSave={(config) => {
          actions.setAutofill?.(config);
          onDone();
        }}
      />
    );
  }

  if (page === "calculate" && actions.calculation) {
    const { type, fn, onChange } = actions.calculation;
    return (
      <div className="w-60">
        <SubmenuHeader title={t("calculate")} onBack={() => setPage("main")} />
        <MenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          <CalculationOptions
            type={type}
            fn={fn}
            onPick={(next) => {
              if (next !== (fn ?? null)) onChange(next);
              onDone();
            }}
          />
        </div>
      </div>
    );
  }

  if ((page === "insert-before" || page === "insert-after") && actions.insert) {
    const side = page === "insert-before" ? "before" : "after";
    const { onCreate, onCreateAutofill } = actions.insert;
    return (
      <AddPropertyPanel
        onCreate={(...args) => onCreate(side, ...args)}
        onCreateAutofill={onCreateAutofill ? (name, config) => onCreateAutofill(side, name, config) : undefined}
        onDone={onDone}
      />
    );
  }

  if (page === "confirm" && prop && actions.remove) {
    return (
      <div className="w-64 p-2">
        <p className="text-sm font-medium">{t("confirmDelete", { name: prop.name })}</p>
        <p className="mt-1 text-xs text-fg-muted">{t("confirmDeleteBody")}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPage("main")}>
            {tc("cancel")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              actions.remove?.();
              onDone();
            }}
          >
            {tc("delete")}
          </Button>
        </div>
      </div>
    );
  }

  const icon = (Icon: typeof ArrowUp) => <Icon className="h-3.5 w-3.5" />;
  const selectType = prop?.type === "select" || prop?.type === "multi_select" || prop?.type === "status";
  // The property's own settings, then what the view does with the column, then its width and
  // wrapping, then new columns beside it, then deleting it (Notion's order).
  const settings = [
    prop?.type === "formula" && actions.setFormula && (
      <MenuItem key="formula" icon={icon(Sigma)} onClick={() => setPage("formula")}>
        {t("editFormula")}
      </MenuItem>
    ),
    prop?.type === "rollup" && actions.setRollup && (
      <MenuItem key="rollup" icon={icon(Combine)} onClick={() => setPage("rollup")}>
        {t("editRollup")}
      </MenuItem>
    ),
    prop?.type === "text" && prop.options.ai && actions.updateAllAutofill && (
      <MenuItem key="update-all" icon={icon(RefreshCw)} onClick={run(actions.updateAllAutofill)}>
        {ta("updateAll")}
      </MenuItem>
    ),
    prop?.type === "text" && actions.setAutofill && (
      <MenuItem key="autofill" icon={icon(Bot)} onClick={() => setPage("autofill")}>
        {ta("configure")}
      </MenuItem>
    ),
    prop?.type === "text" && prop.options.ai && actions.setAutofill && (
      <MenuItem key="autofill-off" icon={icon(BotOff)} onClick={run(() => actions.setAutofill?.(null))}>
        {ta("turnOff")}
      </MenuItem>
    ),
    selectType && actions.setOptions && (
      <MenuItem key="options" icon={icon(Settings2)} onClick={() => setPage("options")}>
        {t("editOptions")}
      </MenuItem>
    ),
    prop && actions.openAccess && (
      <MenuItem
        key="access"
        icon={icon(Lock)}
        disabled={!canRestrict(prop.type)}
        title={canRestrict(prop.type) ? undefined : tAccess("unavailable")}
        onClick={run(actions.openAccess)}
      >
        {tAccess("menuItem")}
      </MenuItem>
    ),
    prop && actions.openAccess && !canRestrict(prop.type) && (
      <div key="access-hint" className="px-2 pb-1 text-xs text-fg-faint">
        {tAccess("unavailable")}
      </div>
    ),
  ].filter(Boolean);
  const view = [
    actions.filter && (
      <MenuItem key="filter" icon={icon(ListFilter)} onClick={run(actions.filter)}>
        {t("filter")}
      </MenuItem>
    ),
    actions.sort && (
      <MenuItem key="asc" icon={icon(ArrowUp)} onClick={run(() => actions.sort?.("asc"))}>
        {t("sortAscending")}
      </MenuItem>
    ),
    actions.sort && (
      <MenuItem key="desc" icon={icon(ArrowDown)} onClick={run(() => actions.sort?.("desc"))}>
        {t("sortDescending")}
      </MenuItem>
    ),
    actions.group && (
      <MenuItem key="group" icon={icon(Rows3)} onClick={run(actions.group)}>
        {t("group")}
      </MenuItem>
    ),
    actions.ungroup && (
      <MenuItem key="ungroup" icon={icon(Ungroup)} onClick={run(actions.ungroup)}>
        {t("ungroup")}
      </MenuItem>
    ),
    actions.calculation && (
      <MenuItem key="calculate" icon={icon(Calculator)} trailing={icon(ChevronRight)} onClick={() => setPage("calculate")}>
        {t("calculate")}
      </MenuItem>
    ),
  ].filter(Boolean);
  const layout = [
    actions.hide && (
      <MenuItem key="hide" icon={icon(EyeOff)} onClick={run(actions.hide)}>
        {t("hide")}
      </MenuItem>
    ),
    actions.toggleWrap && (
      <MenuItem
        key="wrap"
        icon={icon(WrapText)}
        pressed={Boolean(actions.wrapped)}
        trailing={actions.wrapped ? icon(Check) : undefined}
        onClick={run(actions.toggleWrap)}
      >
        {t("wrap")}
      </MenuItem>
    ),
  ].filter(Boolean);
  const insert = (actions.insert?.sides ?? []).map((side) => (
    <MenuItem
      key={side}
      icon={icon(side === "before" ? ArrowLeftToLine : ArrowRightToLine)}
      onClick={() => setPage(side === "before" ? "insert-before" : "insert-after")}
    >
      {t(side === "before" ? "insertLeft" : "insertRight")}
    </MenuItem>
  ));
  const remove = prop && actions.remove && (
    <MenuItem key="delete" danger icon={icon(Trash2)} onClick={() => setPage("confirm")}>
      {t("delete")}
    </MenuItem>
  );
  const sections = [settings, view, layout, insert, remove ? [remove] : []].filter((s) => s.length);

  return (
    <div className="w-60">
      {prop && (
        <>
          <div className="p-1">
            <Input
              value={name}
              aria-label={t("name")}
              readOnly={!actions.rename}
              autoFocus={Boolean(actions.rename)}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitName();
                  onDone();
                }
              }}
              className="h-7"
            />
          </div>
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-fg-muted">
            <PropertyTypeIcon type={prop.type} />
            {typeLabel(prop.type)}
          </div>
          {prop.type === "relation" && <RelationInfo prop={prop} />}
          {isComputed(prop.type) && <div className="px-2 pb-1 text-xs text-fg-faint">{t("readOnlyHint")}</div>}
          {isDerived(prop.type) && (
            <div className="px-2 pb-1 text-xs text-fg-faint">{t(prop.type === "rollup" ? "rollupHint" : "formulaHint")}</div>
          )}
          {sections.length > 0 && <MenuSeparator />}
        </>
      )}
      {sections.map((items, i) => (
        <Fragment key={i}>
          {i > 0 && <MenuSeparator />}
          {items}
        </Fragment>
      ))}
    </div>
  );
}

/** A submenu's title line with a way back to the menu it opened from. */
function SubmenuHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useTranslations("database.propertyMenu");
  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <button
        type="button"
        aria-label={t("back")}
        onClick={onBack}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

function OptionsEditor({
  prop,
  onChange,
  onBack,
}: {
  prop: Property;
  onChange: (options: SelectOption[]) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const tColor = useTranslations("database.colors");
  const tGroup = useTranslations("database.statusGroups");
  const status = prop.type === "status";
  // Edited locally and saved per change; the parent applies it optimistically.
  const [options, setOptions] = useState<SelectOption[]>(() =>
    status ? sortStatusOptions(prop.options.options ?? []) : (prop.options.options ?? []),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Status: the group whose "add an option" field is open.
  const [addingTo, setAddingTo] = useState<StatusGroup | null>(null);

  const save = (next: SelectOption[]) => {
    const ordered = status ? sortStatusOptions(next) : next;
    setOptions(ordered);
    onChange(ordered);
  };

  const add = (group?: StatusGroup) => {
    const name = newName.trim();
    if (!name) return;
    if (options.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      setNewName("");
      return;
    }
    const option: SelectOption = group
      ? { id: crypto.randomUUID(), name, color: statusColor(group), group }
      : { id: crypto.randomUUID(), name, color: SELECT_COLORS[options.length % SELECT_COLORS.length] };
    save([...options, option]);
    setNewName("");
  };

  const optionRow = (o: SelectOption) => (
    <div key={o.id} className="rounded px-1 py-0.5 hover:bg-bg-subtle">
      <div className="flex items-center gap-1">
        {editing === o.id ? (
          <OptionNameInput
            name={o.name}
            label={t("optionName")}
            onSave={(name) => {
              // Names stay unique: lookups by name (typing a tag, MCP) would pick the wrong one.
              const taken = options.some((x) => x.id !== o.id && x.name.toLowerCase() === name.toLowerCase());
              if (name && name !== o.name && !taken) save(options.map((x) => (x.id === o.id ? { ...x, name } : x)));
            }}
            onDone={() => setEditing(null)}
          />
        ) : (
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(o.id)} title={t("renameOption")}>
            <OptionChip option={o} dot={status} />
          </button>
        )}
        {status && (
          <select
            aria-label={t("statusGroup")}
            title={t("statusGroup")}
            value={statusGroupOf(o)}
            onChange={(e) => {
              const group = e.target.value as StatusGroup;
              save(options.map((x) => (x.id === o.id ? { ...x, group } : x)));
            }}
            className="h-6 max-w-28 shrink-0 rounded border border-border bg-bg px-1 text-xs text-fg-muted outline-none focus:border-accent"
          >
            {STATUS_GROUPS.map((group) => (
              <option key={group} value={group}>
                {tGroup(group)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-label={t("deleteOptionNamed", { name: o.name })}
          title={t("deleteOption")}
          onClick={() => save(options.filter((x) => x.id !== o.id))}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1 mb-0.5 flex gap-1">
        {SELECT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={t("color", { color: tColor(color) })}
            title={tColor(color)}
            onClick={() => color !== o.color && save(options.map((x) => (x.id === o.id ? { ...x, color } : x)))}
            className={cn(
              `opt-${color} h-4 w-4 rounded`,
              color === o.color ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:ring-1 hover:ring-border",
            )}
          />
        ))}
      </div>
    </div>
  );

  const newOptionInput = (group?: StatusGroup) => (
    <div className="flex items-center gap-1 p-1">
      <Input
        autoFocus={Boolean(group)}
        value={newName}
        placeholder={t("addOptionPlaceholder")}
        aria-label={group ? t("addToGroup", { group: tGroup(group) }) : t("newOption")}
        className="h-7"
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add(group)}
      />
      <button
        type="button"
        aria-label={t("addOption")}
        onClick={() => add(group)}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );

  if (status) {
    return (
      <div className="w-80">
        <div className="flex items-center gap-1 px-1 pb-1">
          <button
            type="button"
            aria-label={t("back")}
            onClick={onBack}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-sm font-medium">{t("optionsTitle", { name: prop.name })}</span>
        </div>
        <MenuSeparator />
        <div className="max-h-96 overflow-y-auto">
          {STATUS_GROUPS.map((group) => (
            <div key={group} className="pb-1">
              <div className="flex items-center justify-between px-2 pt-1.5 pb-0.5">
                <span className="text-xs font-medium text-fg-muted">{tGroup(group)}</span>
                <button
                  type="button"
                  aria-label={t("addToGroup", { group: tGroup(group) })}
                  title={t("addToGroup", { group: tGroup(group) })}
                  onClick={() => {
                    setNewName("");
                    setAddingTo(addingTo === group ? null : group);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {options.filter((o) => statusGroupOf(o) === group).map(optionRow)}
              {addingTo === group && newOptionInput(group)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-72">
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={onBack}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-sm font-medium">{t("optionsTitle", { name: prop.name })}</span>
      </div>
      <MenuSeparator />
      <div className="max-h-80 overflow-y-auto">
        {!options.length && <div className="px-2 py-2 text-xs text-fg-faint">{t("noOptions")}</div>}
        {options.map((o) => (
          <div key={o.id} className="rounded px-1 py-0.5 hover:bg-bg-subtle">
            <div className="flex items-center gap-1">
              {editing === o.id ? (
                <OptionNameInput
                  name={o.name}
                  label={t("optionName")}
                  onSave={(name) => {
                    // Names stay unique: lookups by name (typing a tag, MCP) would pick the wrong one.
                    const taken = options.some((x) => x.id !== o.id && x.name.toLowerCase() === name.toLowerCase());
                    if (name && name !== o.name && !taken) save(options.map((x) => (x.id === o.id ? { ...x, name } : x)));
                  }}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setEditing(o.id)}
                  title={t("renameOption")}
                >
                  <OptionChip option={o} />
                </button>
              )}
              <button
                type="button"
                aria-label={t("deleteOptionNamed", { name: o.name })}
                title={t("deleteOption")}
                onClick={() => save(options.filter((x) => x.id !== o.id))}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1 mb-0.5 flex gap-1">
              {SELECT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={t("color", { color: tColor(color) })}
                  title={tColor(color)}
                  onClick={() => color !== o.color && save(options.map((x) => (x.id === o.id ? { ...x, color } : x)))}
                  className={cn(
                    `opt-${color} h-4 w-4 rounded`,
                    color === o.color ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:ring-1 hover:ring-border",
                  )}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <MenuSeparator />
      <div className="flex items-center gap-1 p-1">
        <Input
          value={newName}
          placeholder={t("addOptionPlaceholder")}
          aria-label={t("newOption")}
          className="h-7"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          type="button"
          aria-label={t("addOption")}
          onClick={() => add()}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Which database a relation points to, and whether it is mirrored there. */
function RelationInfo({ prop }: { prop: Property }) {
  const t = useTranslations("database.relation");
  const tc = useTranslations("common");
  const target = useRelations()?.targets[prop.id];
  if (!target?.database) return <div className="px-2 pb-1 text-xs text-fg-faint">{t("missingDatabase")}</div>;
  return (
    <div className="px-2 pb-1 text-xs text-fg-muted">
      <div className="truncate">{t("relatedTo", { title: pageLabel(target.database.title, tc("untitled")) })}</div>
      {target.pairedName && <div className="truncate">{t("pairedWith", { name: target.pairedName })}</div>}
    </div>
  );
}

/**
 * Rename field for an option. Saves on Enter, blur and unmount: closing the menu by clicking
 * outside or pressing Escape unmounts it before the input's blur fires.
 */
function OptionNameInput({
  name,
  label,
  onSave,
  onDone,
}: {
  name: string;
  label: string;
  onSave: (name: string) => void;
  onDone: () => void;
}) {
  // Tracked outside the DOM: element refs are already detached when the unmount save runs.
  const draft = useRef(name);
  const saved = useRef(false);
  const save = () => {
    if (saved.current) return;
    saved.current = true;
    onSave(draft.current.trim());
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    // Reset for Strict Mode's remount; the unmount save is a no-op while the name is unchanged.
    saved.current = false;
    return () => saveRef.current();
  }, []);
  return (
    <Input
      autoFocus
      defaultValue={name}
      aria-label={label}
      className="h-6 flex-1"
      onChange={(e) => {
        draft.current = e.target.value;
      }}
      onBlur={() => {
        save();
        onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          save();
          onDone();
        }
      }}
    />
  );
}
