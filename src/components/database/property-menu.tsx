"use client";

import { PropertyIconButton } from "./schema-icons";
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowLeft,
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Bell,
  Bot,
  BotOff,
  Calculator,
  CalendarCog,
  Check,
  ChevronRight,
  Combine,
  Copy,
  CopyX,
  Eye,
  EyeOff,
  Fingerprint,
  GripVertical,
  Gauge,
  Hash,
  Link,
  Link2,
  ListFilter,
  Lock,
  PanelTop,
  Pin,
  Percent,
  PinOff,
  Plus,
  RefreshCw,
  Rows3,
  Settings2,
  Sigma,
  SquareCheck,
  Trash2,
  Ungroup,
  UserRound,
  WrapText,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useReorderDrag, type ReorderDragHandlers } from "@/components/use-reorder-drag";
import { useDirection } from "@/components/direction";
import { Button, cn, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { isComputed, isDerived, PROPERTY_TYPES, STATUS_GROUPS, type StatusGroup } from "@/lib/property-types";
import { pageLabel } from "@/lib/labels";
import { canRestrict } from "@/lib/property-access";
import { SELECT_COLORS, sortOptionsByName, sortStatusOptions, statusColor, statusGroupOf } from "@/lib/properties";
import { isAutofillType, type AiAutofillConfig } from "@/lib/ai";
import { canBeParent, canDepend, dependencyProblem, withoutParentOptions } from "@/lib/dependent-options";
import { MAX_PROPERTY_DESCRIPTION, propertyDescription } from "@/lib/property-description";
import type { AggregateFn } from "@/lib/aggregate";
import { takesDateOptions, type DateOptionsInput } from "@/lib/date-options";
import type { RelationOptionsInput } from "@/lib/relation-options";
import type { NumberDisplay } from "@/lib/number-display";
import { takesNumberFormat, type NumberFormat } from "@/lib/number-format";
import { PAGE_VISIBILITIES, pageVisibilityOf, type PageVisibility } from "@/lib/page-visibility";
import { isPinned, MAX_PINNED } from "@/lib/row-layout";
import { cleanUniqueIdPrefix, formatUniqueId, MAX_UNIQUE_ID_PREFIX, uniqueIdPrefix } from "@/lib/unique-id";
import { canBeUnique } from "@/lib/unique-values";
import { AutofillEditor } from "./ai-autofill";
import { DateOptionsEditor } from "./date-options-menu";
import { FormulaEditor } from "./formula-editor";
import { RelationOptionsEditor } from "./relation-options-menu";
import { RollupEditor } from "./rollup-editor";
import { CalculationOptions } from "./table-calculations";
import { OptionChip } from "./property-cell";
import { isNumberKind, NEW_PROPERTY_KINDS, NUMBER_KINDS, PropertyTypeIcon, useNewPropertyKindLabel, usePropertyTypeLabel, type NewPropertyKind } from "./property-icons";
import { RelationSetup } from "./relation-cell";
import { useRelations } from "./relation-context";
import { useSchema } from "./schema-context";
import { newPropertyName, typesMatching } from "@/lib/property-type-search";
import type { DerivedInput, Property, PropertyType, RelationInput, RollupInput, SelectOption } from "./types";

// The number format submenu loads when it opens: most menus never show it.
const NumberFormatEditor = dynamic(() => import("./number-format-menu").then((m) => m.NumberFormatEditor));
const NumberDisplayEditor = dynamic(() => import("./number-format-menu").then((m) => m.NumberDisplayEditor));

/**
 * Name + type picker used by the table "+" header and the row page "Add property". The name also
 * finds types: typing narrows the list to the types it names, arrows move through it and Enter
 * makes the one marked (text when the name names none), named after its type when that is all the
 * name says.
 */
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
  const typeLabel = useNewPropertyKindLabel();
  const [name, setName] = useState("");
  const [step, setStep] = useState<"type" | "relation" | "formula" | "rollup" | "unique_id" | "autofill">("type");
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => input.current?.focus(), []);
  const matching = typesMatching(NEW_PROPERTY_KINDS, typeLabel, name);
  const listed = matching.length ? matching : NEW_PROPERTY_KINDS;
  // The type Enter makes: the one moved to with the arrows, else the first found, else text.
  const [moved, setMoved] = useState<number | null>(null);
  const marked = moved ?? (matching.length ? 0 : Math.max(0, listed.indexOf("text")));
  const types = useRef<HTMLDivElement>(null);
  // A block body: scrollIntoView returns a promise in newer browsers, and an effect may only return a cleanup.
  useEffect(() => {
    types.current?.querySelector("[data-marked]")?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  // A new property without a name, or named just as a type is, is named after its type in the user's language.
  const nameFor = (type: NewPropertyKind) => newPropertyName(type, typeLabel, name);
  const create = (type: NewPropertyKind) => {
    if (type === "relation" || type === "formula" || type === "rollup" || type === "unique_id") {
      setStep(type);
      return;
    }
    // A rating or a duration is a number in that format.
    if (isNumberKind(type)) void onCreate(nameFor(type), "number", undefined, { number: NUMBER_KINDS[type].format });
    else void onCreate(nameFor(type), type);
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
  if (step === "unique_id") {
    return (
      <UniqueIdEditor
        prop={null}
        onBack={() => setStep("type")}
        onSave={(prefix) => {
          void onCreate(nameFor("unique_id"), "unique_id", undefined, { prefix });
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
          onChange={(e) => {
            setName(e.target.value);
            setMoved(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") create(listed[marked] ?? "text");
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setMoved((marked + (e.key === "ArrowDown" ? 1 : listed.length - 1)) % listed.length);
            }
          }}
          aria-controls={listId}
          className="h-7"
        />
      </div>
      <div className="px-2 pt-1.5 pb-1 text-xs text-fg-muted">{t("type")}</div>
      <div ref={types} id={listId}>
        {listed.map((type, i) => (
          <div key={type} data-marked={i === marked ? "" : undefined}>
            <MenuItem icon={<PropertyTypeIcon type={type} />} active={i === marked} onClick={() => create(type)}>
              {typeLabel(type)}
            </MenuItem>
          </div>
        ))}
      </div>
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

/** A new type for a property, with the settings it needs (see databases.changePropertyType). */
export type TypeChangeInput = {
  type: PropertyType;
  relation?: RelationInput;
  formula?: { expression: string };
  rollup?: RollupInput;
};

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
  /** Keeps the columns up to this one in place while the table scrolls sideways; `unfreeze` instead while it does. */
  freeze?: () => void;
  unfreeze?: () => void;
  /** Turns wrapping the column's cells onto more lines on and off; `wrapped` says whether it is on. */
  toggleWrap?: () => void;
  wrapped?: boolean;
  /** Adds a property left ("before") or right ("after") of the column, on the sides listed. */
  insert?: {
    sides: ("before" | "after")[];
    onCreate: (side: "before" | "after", ...args: Parameters<React.ComponentProps<typeof AddPropertyPanel>["onCreate"]>) => void | Promise<unknown>;
    onCreateAutofill?: (side: "before" | "after", name: string, config: AiAutofillConfig) => void | Promise<unknown>;
  };
  /** Adds a copy of the property, with its values, right after it. */
  duplicate?: () => void;
  /**
   * Changes the property's type. `lost`: how many values the viewer sees would be cleared, null
   * when only the server can tell (links are found by title in the related database).
   */
  changeType?: {
    lost: (type: PropertyType) => number | null;
    apply: (change: TypeChangeInput) => void | Promise<unknown>;
  };
  setOptions?: (options: SelectOption[]) => void;
  /** Selects and multi-selects: the select property this one depends on (null for none; see lib/dependent-options). */
  setDependsOn?: (propertyId: string | null) => void;
  /** Saves what the property holds and how to fill it (null for nothing; see lib/property-description). */
  setDescription?: (description: string | null) => void;
  /** Sets the icon shown instead of the type's (null for the type's). */
  setIcon?: (icon: string | null) => void;
  /** Formulas: saves a new expression (with property ids, see FormulaEditor). */
  setFormula?: (expression: string) => void;
  /** Rollups: saves new settings. */
  setRollup?: (rollup: RollupInput) => void;
  /** Numbers: saves how values show (null for plain numbers). */
  setNumberFormat?: (format: NumberFormat | null) => void;
  /** Numbers: shows values as a bar or a ring (null for the number). */
  setNumberDisplay?: (display: NumberDisplay | null) => void;
  /** Dates: saves how values show and the reminder (see lib/date-options). */
  setDateOptions?: (input: DateOptionsInput) => void;
  /** Relations: saves the limit, where row pages show it and what linked rows show (see lib/relation-options). */
  setRelationOptions?: (input: RelationOptionsInput) => void;
  /** Unique IDs: saves the prefix they show with (null for none; see lib/unique-id). */
  setUniqueIdPrefix?: (prefix: string | null) => void;
  /** URLs: whether row pages show a preview of the linked page (server/url-preview.ts). */
  setUrlPreview?: (on: boolean) => void;
  /** People: whether a row names one person at most. */
  setOnePerson?: (on: boolean) => void;
  /** Text, numbers, emails, URLs and phone numbers: whether no two rows may hold the same value (lib/unique-values). */
  setUnique?: (on: boolean) => void;
  /** Statuses: whether they show as a checkbox ticked for done options. */
  setStatusCheckbox?: (on: boolean) => void;
  /** Relations: whether a row links one row at most. */
  setOneRow?: (on: boolean) => void;
  /** One-way relations: adds the paired property to the related database. */
  makeTwoWay?: () => void;
  /** Text properties, when AI is available: turns AI autofill on, changes it or (null) turns it off. */
  setAutofill?: (config: AiAutofillConfig | null) => void;
  /** Autofill properties: works the values of the view's rows out again. */
  updateAllAutofill?: () => void;
  /** Saves whether the property shows on row pages: always, only with a value, or never. */
  setPageVisibility?: (visibility: PageVisibility) => void;
  /** Full access: pins the property under its rows' titles or unpins it (lib/row-layout); `pinFull` while no more fit. */
  setPinned?: (pinned: boolean) => void;
  pinFull?: boolean;
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
  const dir = useDirection();
  const tc = useTranslations("common");
  const typeLabel = usePropertyTypeLabel();
  const ta = useTranslations("ai.autofill");
  const tAccess = useTranslations("database.propertyAccess");
  // The menu item says the current format: "Percent", or a currency's code.
  const numberFormatLabel = (format: NumberFormat | undefined) =>
    format?.format === "currency" && format.currency
      ? format.currency
      : t(format?.format === "percent" ? "formatPercent" : "formatNumber");
  const [page, setPage] = useState<
    | "main"
    | "options"
    | "confirm"
    | "formula"
    | "rollup"
    | "number-format"
    | "date-options"
    | "relation-options"
    | "number-display"
    | "unique-id"
    | "page-visibility"
    | "autofill"
    | "calculate"
    | "insert-before"
    | "insert-after"
    | "type"
    | "type-relation"
    | "type-formula"
    | "type-rollup"
    | "type-confirm"
  >("main");
  // A type change waiting for the user to accept the values it clears.
  const [pending, setPending] = useState<{ change: TypeChangeInput; lost: number | null } | null>(null);
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

  const changeType = actions.changeType;
  // Changes the type straight away when no value would be lost, else asks first.
  const chooseType = (change: TypeChangeInput) => {
    const lost = changeType?.lost(change.type) ?? 0;
    if (lost === 0) {
      void changeType?.apply(change);
      onDone();
      return;
    }
    setPending({ change, lost });
    setPage("type-confirm");
  };

  if (page === "type" && prop && changeType) {
    return (
      <div className="w-60">
        <SubmenuHeader title={t("changeType")} onBack={() => setPage("main")} />
        <MenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {PROPERTY_TYPES.map((type) => (
            <MenuItem
              key={type}
              icon={<PropertyTypeIcon type={type} />}
              active={type === prop.type}
              trailing={type === prop.type ? <Check className="h-3.5 w-3.5" /> : undefined}
              onClick={() => {
                if (type === prop.type) setPage("main");
                else if (type === "relation" || type === "formula" || type === "rollup") setPage(`type-${type}`);
                else chooseType({ type });
              }}
            >
              {typeLabel(type)}
            </MenuItem>
          ))}
        </div>
      </div>
    );
  }

  if (page === "type-relation" && prop && changeType) {
    return (
      <RelationSetup name={prop.name} onBack={() => setPage("type")} onCreate={(relation) => chooseType({ type: "relation", relation })} />
    );
  }

  if (page === "type-formula" && prop && changeType) {
    return (
      <FormulaEditor
        prop={prop}
        name={prop.name}
        onBack={() => setPage("type")}
        onSave={(expression) => chooseType({ type: "formula", formula: { expression } })}
      />
    );
  }

  if (page === "type-rollup" && prop && changeType) {
    return (
      <RollupEditor prop={prop} name={prop.name} onBack={() => setPage("type")} onSave={(rollup) => chooseType({ type: "rollup", rollup })} />
    );
  }

  if (page === "type-confirm" && prop && changeType && pending) {
    const type = typeLabel(pending.change.type);
    return (
      <div className="w-64 p-2">
        <p className="text-sm font-medium">{t("confirmType", { name: prop.name, type })}</p>
        <p className="mt-1 text-xs text-fg-muted">
          {pending.lost === null ? t("confirmTypeRelation") : t("confirmTypeLost", { count: pending.lost, type })}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPage("type")}>
            {tc("cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              void changeType.apply(pending.change);
              onDone();
            }}
          >
            {t("changeType")}
          </Button>
        </div>
      </div>
    );
  }

  if (page === "options" && prop && actions.setOptions) {
    return (
      <OptionsEditor
        prop={prop}
        onChange={actions.setOptions}
        onDependsOn={canDepend(prop.type) ? actions.setDependsOn : undefined}
        onBack={() => setPage("main")}
      />
    );
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

  if (page === "number-format" && prop && actions.setNumberFormat) {
    return (
      <NumberFormatEditor
        prop={prop}
        onChange={actions.setNumberFormat}
        // Number properties and formulas giving a number show as a bar or a ring where it is offered.
        onDisplayChange={actions.setNumberDisplay}
        onBack={() => setPage("main")}
      />
    );
  }

  if (page === "date-options" && prop && actions.setDateOptions) {
    return <DateOptionsEditor prop={prop} onChange={actions.setDateOptions} onBack={() => setPage("main")} />;
  }

  if (page === "relation-options" && prop && actions.setRelationOptions) {
    return <RelationOptionsEditor prop={prop} onChange={actions.setRelationOptions} onBack={() => setPage("main")} />;
  }

  if (page === "number-display" && prop && actions.setNumberDisplay) {
    return <NumberDisplayEditor prop={prop} onChange={actions.setNumberDisplay} onBack={() => setPage("main")} />;
  }

  if (page === "unique-id" && prop && actions.setUniqueIdPrefix) {
    return (
      <UniqueIdEditor
        prop={prop}
        onBack={() => setPage("main")}
        onSave={(prefix) => {
          if (prefix !== uniqueIdPrefix(prop)) actions.setUniqueIdPrefix?.(prefix);
          onDone();
        }}
      />
    );
  }

  if (page === "page-visibility" && prop && actions.setPageVisibility) {
    const current = pageVisibilityOf(prop);
    return (
      <div className="w-60">
        <SubmenuHeader title={t("rowPage")} onBack={() => setPage("main")} />
        <MenuSeparator />
        {PAGE_VISIBILITIES.map((visibility) => (
          <MenuItem
            key={visibility}
            active={visibility === current}
            trailing={visibility === current ? <Check className="h-3.5 w-3.5" /> : undefined}
            onClick={run(() => visibility !== current && actions.setPageVisibility?.(visibility))}
          >
            {t(`pageVisibility.${visibility}`)}
          </MenuItem>
        ))}
        <p className="px-2 pt-1 pb-1.5 text-xs text-fg-faint">{t("pageVisibilityHint")}</p>
      </div>
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
        {prop.type === "relation" && <PairedDeleteNote propertyId={prop.id} />}
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
  // wrapping, then new columns beside it, then deleting it.
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
    prop && takesNumberFormat(prop.type, prop.options.formula?.type) && actions.setNumberFormat && (
      <MenuItem
        key="number-format"
        icon={icon(Percent)}
        trailing={
          <>
            <span className="me-1 text-xs">{numberFormatLabel(prop.options.number)}</span>
            <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </>
        }
        onClick={() => setPage("number-format")}
      >
        {t("numberFormat")}
      </MenuItem>
    ),
    prop?.type === "unique_id" && actions.setUniqueIdPrefix && (
      <MenuItem
        key="unique-id"
        icon={icon(Fingerprint)}
        trailing={
          <>
            <span className="me-1 text-xs">{uniqueIdPrefix(prop) ?? t("uniqueIdPrefixNone")}</span>
            <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </>
        }
        onClick={() => setPage("unique-id")}
      >
        {t("uniqueIdPrefix")}
      </MenuItem>
    ),
    prop && takesDateOptions(prop.type) && actions.setDateOptions && (
      <MenuItem
        key="date-options"
        // The bell says a reminder is on; the details are a click away.
        icon={icon(prop.options.date?.reminder ? Bell : CalendarCog)}
        trailing={<ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
        onClick={() => setPage("date-options")}
      >
        {t("dateOptions")}
      </MenuItem>
    ),
    prop?.type === "relation" && actions.setRelationOptions && (
      <MenuItem key="relation-options" icon={icon(Link)} trailing={<ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} onClick={() => setPage("relation-options")}>
        {t("relationOptions")}
      </MenuItem>
    ),
    prop?.type === "rollup" && actions.setNumberDisplay && (
      <MenuItem key="number-display" icon={icon(Gauge)} trailing={<ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} onClick={() => setPage("number-display")}>
        {t("showAs")}
      </MenuItem>
    ),
    prop?.type === "url" && actions.setUrlPreview && (
      <MenuItem
        key="url-preview"
        icon={icon(PanelTop)}
        pressed={Boolean(prop.options.url?.preview)}
        trailing={prop.options.url?.preview ? icon(Check) : undefined}
        title={t("urlPreviewHint")}
        onClick={run(() => actions.setUrlPreview?.(!prop.options.url?.preview))}
      >
        {t("urlPreview")}
      </MenuItem>
    ),
    prop?.type === "status" && actions.setStatusCheckbox && (
      <MenuItem
        key="status-checkbox"
        icon={icon(SquareCheck)}
        pressed={prop.options.statusDisplay === "checkbox"}
        trailing={prop.options.statusDisplay === "checkbox" ? icon(Check) : undefined}
        title={t("statusCheckboxHint")}
        onClick={run(() => actions.setStatusCheckbox?.(prop.options.statusDisplay !== "checkbox"))}
      >
        {t("statusCheckbox")}
      </MenuItem>
    ),
    prop?.type === "relation" && actions.makeTwoWay && !prop.options.relation?.pairedPropertyId && !prop.options.relation?.role && (
      <TwoWayItem key="two-way" prop={prop} onClick={run(actions.makeTwoWay)} />
    ),
    prop?.type === "relation" && actions.setOneRow && prop.options.relation?.role !== "parent" && (
      <MenuItem
        key="one-row"
        icon={icon(Link2)}
        pressed={Boolean(prop.options.relation?.single)}
        trailing={prop.options.relation?.single ? icon(Check) : undefined}
        title={t("oneRowHint")}
        onClick={run(() => actions.setOneRow?.(!prop.options.relation?.single))}
      >
        {t("oneRow")}
      </MenuItem>
    ),
    prop && canBeUnique(prop.type) && actions.setUnique && (
      <MenuItem
        key="unique"
        icon={icon(CopyX)}
        pressed={Boolean(prop.options.unique)}
        trailing={prop.options.unique ? icon(Check) : undefined}
        title={t("uniqueValuesHint")}
        onClick={run(() => actions.setUnique?.(!prop.options.unique))}
      >
        {t("uniqueValues")}
      </MenuItem>
    ),
    prop?.type === "person" && actions.setOnePerson && (
      <MenuItem
        key="one-person"
        icon={icon(UserRound)}
        pressed={Boolean(prop.options.person?.single)}
        trailing={prop.options.person?.single ? icon(Check) : undefined}
        title={t("onePersonHint")}
        onClick={run(() => actions.setOnePerson?.(!prop.options.person?.single))}
      >
        {t("onePerson")}
      </MenuItem>
    ),
    isAutofillType(prop?.type) && prop?.options.ai && actions.updateAllAutofill && (
      <MenuItem key="update-all" icon={icon(RefreshCw)} onClick={run(actions.updateAllAutofill)}>
        {ta("updateAll")}
      </MenuItem>
    ),
    isAutofillType(prop?.type) && actions.setAutofill && (
      <MenuItem key="autofill" icon={icon(Bot)} onClick={() => setPage("autofill")}>
        {ta("configure")}
      </MenuItem>
    ),
    isAutofillType(prop?.type) && prop?.options.ai && actions.setAutofill && (
      <MenuItem key="autofill-off" icon={icon(BotOff)} onClick={run(() => actions.setAutofill?.(null))}>
        {ta("turnOff")}
      </MenuItem>
    ),
    selectType && actions.setOptions && (
      <MenuItem key="options" icon={icon(Settings2)} onClick={() => setPage("options")}>
        {t("editOptions")}
      </MenuItem>
    ),
    prop && actions.setPageVisibility && (
      <MenuItem
        key="page-visibility"
        icon={icon(pageVisibilityOf(prop) === "show" ? Eye : EyeOff)}
        trailing={
          <>
            <span className="me-1 text-xs">{t(`pageVisibilityShort.${pageVisibilityOf(prop)}`)}</span>
            <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </>
        }
        onClick={() => setPage("page-visibility")}
      >
        {t("rowPage")}
      </MenuItem>
    ),
    prop && actions.setPinned && (
      <MenuItem
        key="pin"
        icon={icon(isPinned(prop) ? PinOff : Pin)}
        disabled={!isPinned(prop) && actions.pinFull}
        title={!isPinned(prop) && actions.pinFull ? t("pinFull", { max: MAX_PINNED }) : undefined}
        onClick={run(() => actions.setPinned?.(!isPinned(prop)))}
      >
        {t(isPinned(prop) ? "unpinFromTitle" : "pinToTitle")}
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
      <MenuItem key="calculate" icon={icon(Calculator)} trailing={<ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} onClick={() => setPage("calculate")}>
        {t("calculate")}
      </MenuItem>
    ),
  ].filter(Boolean);
  const layout = [
    actions.freeze && (
      <MenuItem key="freeze" icon={icon(Pin)} onClick={run(actions.freeze)}>
        {t("freeze")}
      </MenuItem>
    ),
    actions.unfreeze && (
      <MenuItem key="unfreeze" icon={icon(PinOff)} onClick={run(actions.unfreeze)}>
        {t("unfreeze")}
      </MenuItem>
    ),
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
  const insert = [
    ...(actions.insert?.sides ?? []).map((side) => {
      // Columns run from the right when the page does: there, the one before is on the right.
      const left = (side === "before") !== (dir === "rtl");
      return (
        <MenuItem
          key={side}
          icon={icon(left ? ArrowLeftToLine : ArrowRightToLine)}
          onClick={() => setPage(side === "before" ? "insert-before" : "insert-after")}
        >
          {t(left ? "insertLeft" : "insertRight")}
        </MenuItem>
      );
    }),
    prop && actions.duplicate && (
      <MenuItem key="duplicate" icon={icon(Copy)} onClick={run(actions.duplicate)}>
        {t("duplicate")}
      </MenuItem>
    ),
  ].filter(Boolean);
  // The REST API and MCP clients take a property by its id as well as its name, which can change.
  const copyId = prop && (
    <MenuItem key="copy-id" icon={icon(Hash)} onClick={run(() => void navigator.clipboard.writeText(prop.id))}>
      {t("copyId")}
    </MenuItem>
  );
  const remove = prop && actions.remove && (
    <MenuItem key="delete" danger icon={icon(Trash2)} onClick={() => setPage("confirm")}>
      {t("delete")}
    </MenuItem>
  );
  const sections = [settings, view, layout, insert, copyId ? [copyId] : [], remove ? [remove] : []].filter((s) => s.length);

  return (
    <div className="w-60">
      {prop && (
        <>
          <div className="flex items-center gap-1 p-1">
            <PropertyIconButton prop={prop} onIcon={actions.setIcon} />
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
          {changeType ? (
            <div className="px-1">
              <MenuItem
                icon={<PropertyTypeIcon type={prop.type} />}
                trailing={
                  <>
                    <span className="me-1 text-xs">{typeLabel(prop.type)}</span>
                    <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
                  </>
                }
                onClick={() => setPage("type")}
              >
                {t("type")}
              </MenuItem>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-fg-muted">
              <PropertyTypeIcon type={prop.type} />
              {typeLabel(prop.type)}
            </div>
          )}
          {(actions.setDescription || propertyDescription(prop)) && (
            <DescriptionField prop={prop} onSave={actions.setDescription} />
          )}
          {prop.type === "relation" && <RelationInfo prop={prop} />}
          {isComputed(prop.type) && <div className="px-2 pb-1 text-xs text-fg-faint">{t("readOnlyHint")}</div>}
          {prop.type === "unique_id" && <div className="px-2 pb-1 text-xs text-fg-faint">{t("uniqueIdHint")}</div>}
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

/**
 * What the property holds and how to fill it (see lib/property-description), under its name and
 * type. Saved on blur and when the menu closes, like the name; read-only without `onSave`.
 */
function DescriptionField({ prop, onSave }: { prop: Property; onSave?: (description: string | null) => void }) {
  const t = useTranslations("database.propertyMenu");
  const [text, setText] = useState(() => propertyDescription(prop));
  const saved = useRef(propertyDescription(prop));
  const commit = () => {
    const next = text.trim();
    if (!onSave || next === saved.current) return;
    saved.current = next;
    onSave(next || null);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  if (!onSave) return <p className="px-2 pb-1 text-xs whitespace-pre-wrap text-fg-muted">{text}</p>;
  return (
    <div className="px-1 pt-0.5 pb-1">
      <textarea
        value={text}
        rows={2}
        maxLength={MAX_PROPERTY_DESCRIPTION}
        aria-label={t("description")}
        placeholder={t("descriptionPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        className="block max-h-40 min-h-12 w-full resize-none rounded-md [field-sizing:content] border border-border bg-bg px-1.5 py-1 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-accent"
      />
    </div>
  );
}

/** A two-way relation goes with its other side: says so when deleting it. */
function PairedDeleteNote({ propertyId }: { propertyId: string }) {
  const t = useTranslations("database.propertyMenu");
  const pairedName = useRelations()?.targets[propertyId]?.pairedName;
  return pairedName ? <p className="mt-1 text-xs text-fg-muted">{t("confirmDeletePaired", { name: pairedName })}</p> : null;
}

/** A submenu's title line with a way back to the menu it opened from. */
/**
 * A unique ID property's prefix (lib/unique-id), typed in upper case, with the ID the next row
 * gets. `prop` is null while the property is being added.
 */
function UniqueIdEditor({ prop, onBack, onSave }: { prop: Property | null; onBack: () => void; onSave: (prefix: string | null) => void }) {
  const t = useTranslations("database.propertyMenu");
  const tc = useTranslations("common");
  const [value, setValue] = useState(prop ? (uniqueIdPrefix(prop) ?? "") : "");
  const prefix = cleanUniqueIdPrefix(value);
  const save = () => prefix !== undefined && onSave(prefix);
  return (
    <div className="w-64">
      <SubmenuHeader title={t("uniqueIdPrefix")} onBack={onBack} />
      <MenuSeparator />
      <div className="p-2">
        <Input
          value={value}
          autoFocus
          placeholder={t("uniqueIdPrefixPlaceholder")}
          aria-label={t("uniqueIdPrefix")}
          aria-invalid={prefix === undefined}
          maxLength={MAX_UNIQUE_ID_PREFIX + 1}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          className="h-7"
        />
        <p className={cn("mt-1.5 text-xs", prefix === undefined ? "text-danger" : "text-fg-faint")}>
          {t("uniqueIdPrefixHint", { max: MAX_UNIQUE_ID_PREFIX })}
        </p>
        {prefix !== undefined && (
          <p className="mt-2 text-sm">
            <span className="text-fg-muted">{t("uniqueIdPreview")}</span>{" "}
            <span className="font-medium tabular-nums">{formatUniqueId((prop?.lastNumber ?? 0) + 1, prefix)}</span>
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="primary" disabled={prefix === undefined} onClick={save}>
            {prop ? tc("save") : t("uniqueIdCreate")}
          </Button>
        </div>
      </div>
    </div>
  );
}

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
        <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

function OptionsEditor({
  prop,
  onChange,
  onDependsOn,
  onBack,
}: {
  prop: Property;
  onChange: (options: SelectOption[]) => void;
  /** Selects and multi-selects whose settings may change: the select property they depend on. */
  onDependsOn?: (propertyId: string | null) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.propertyMenu");
  const tColor = useTranslations("database.colors");
  const tGroup = useTranslations("database.statusGroups");
  const schema = useSchema();
  const status = prop.type === "status";
  // Dependent selects (lib/dependent-options): the properties it may depend on, and the one it does.
  const [dependsOn, setDependsOn] = useState<string | null>(prop.options.dependsOn ?? null);
  const candidates = onDependsOn ? schema.filter((p) => dependencyProblem(prop, p.id, schema) === null) : [];
  const parent = dependsOn ? (schema.find((p) => p.id === dependsOn && canBeParent(p.type)) ?? null) : null;
  const parentOptions = parent?.options.options ?? [];
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

  // Options are ordered by hand (dragged) or sorted by name once; a status option moves within its group.
  const locale = useLocale();
  const sortByName = (direction: "asc" | "desc") => {
    const sorted = sortOptionsByName(options, direction, locale, status);
    if (sorted.some((o, i) => o.id !== options[i].id)) save(sorted);
  };
  const drag = useReorderDrag(
    "y",
    (moved, target, side) => {
      const option = options.find((o) => o.id === moved);
      const rest = options.filter((o) => o.id !== moved);
      const at = rest.findIndex((o) => o.id === target);
      if (!option || at < 0) return;
      rest.splice(side === "after" ? at + 1 : at, 0, option);
      save(rest);
    },
    "text/x-leafdesk-option",
    status ? (moved, target) => statusGroupOf(options.find((o) => o.id === moved)!) === statusGroupOf(options.find((o) => o.id === target)!) : undefined,
  );
  const sortActions = options.length > 1 && (
    <>
      <MenuSeparator />
      <div className="flex gap-0.5 px-1">
        <button type="button" onClick={() => sortByName("asc")} className={SORT_ACTION}>
          <ArrowDownAZ className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("sortOptionsAsc")}</span>
        </button>
        <button type="button" onClick={() => sortByName("desc")} className={SORT_ACTION}>
          <ArrowDownZA className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("sortOptionsDesc")}</span>
        </button>
      </div>
    </>
  );

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
    <DraggableOption key={o.id} drag={drag.handlers(o.id)} disabled={editing === o.id} label={t("dragOption", { name: o.name })}>
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
          <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setEditing(o.id)} title={t("renameOption")}>
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
    </DraggableOption>
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
            <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </button>
          <span className="text-sm font-medium">{t("optionsTitle", { name: prop.name })}</span>
        </div>
        {sortActions}
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

  const chooseParent = (id: string | null) => {
    if (id === dependsOn) return;
    setDependsOn(id);
    // Lists of the old one's options mean nothing for another (the server forgets them too).
    setOptions((current) => withoutParentOptions(current));
    onDependsOn?.(id);
  };

  /** Which options of the parent `o` goes with: toggles one (none chosen: any). */
  const toggleParent = (o: SelectOption, parentOptionId: string) => {
    const ids = o.parentOptionIds ?? [];
    const next = ids.includes(parentOptionId) ? ids.filter((id) => id !== parentOptionId) : [...ids, parentOptionId];
    save(options.map((x) => (x.id === o.id ? withParents(x, next) : x)));
  };

  return (
    <div className="w-72">
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={onBack}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="text-sm font-medium">{t("optionsTitle", { name: prop.name })}</span>
      </div>
      {onDependsOn && (candidates.length > 0 || dependsOn) && (
        <>
          <MenuSeparator />
          <label className="flex items-center gap-2 px-2 py-1">
            <span className="shrink-0 text-xs text-fg-muted">{t("dependsOn")}</span>
            <select
              value={dependsOn ?? ""}
              onChange={(e) => chooseParent(e.target.value || null)}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-xs text-fg outline-none focus:border-accent"
            >
              <option value="">{t("dependsOnNone")}</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {dependsOn && !candidates.some((p) => p.id === dependsOn) && parent && <option value={parent.id}>{parent.name}</option>}
            </select>
          </label>
          {parent && (
            <p className="px-2 pb-1 text-xs text-fg-faint">
              {parentOptions.length ? t("dependsOnHint", { parent: parent.name }) : t("noParentOptions", { parent: parent.name })}
            </p>
          )}
        </>
      )}
      {sortActions}
      <MenuSeparator />
      <div className="max-h-80 overflow-y-auto">
        {!options.length && <div className="px-2 py-2 text-xs text-fg-faint">{t("noOptions")}</div>}
        {options.map((o) => (
          <DraggableOption key={o.id} drag={drag.handlers(o.id)} disabled={editing === o.id} label={t("dragOption", { name: o.name })}>
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
                  className="min-w-0 flex-1 text-start"
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
            {parent && parentOptions.length > 0 && (
              <div className="mt-1 mb-0.5" role="group" aria-label={t("parentOptionsLabel", { parent: parent.name })}>
                <div className="text-xs text-fg-faint">
                  {t("parentOptionsLabel", { parent: parent.name })}{" "}
                  {!o.parentOptionIds?.length && <span className="text-fg-muted">{t("parentOptionsAll")}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {parentOptions.map((po) => {
                    const on = o.parentOptionIds?.includes(po.id) ?? false;
                    return (
                      <button
                        key={po.id}
                        type="button"
                        aria-pressed={on}
                        title={t("parentOptionToggle", { option: o.name, parent: parent.name, value: po.name })}
                        onClick={() => toggleParent(o, po.id)}
                        className={cn("rounded", on ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "opacity-50 hover:opacity-100")}
                      >
                        <OptionChip option={po} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </DraggableOption>
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

const SORT_ACTION =
  "inline-flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg";

/** One option in the options editor, dragged by its grip to a new place (not while its name is edited). */
function DraggableOption({
  drag,
  disabled,
  label,
  children,
}: {
  drag: ReorderDragHandlers;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      draggable={!disabled}
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
      className={cn("group/option relative flex gap-0.5 rounded py-0.5 pe-1 hover:bg-bg-subtle", drag.dragging && "opacity-50")}
    >
      {drag.dropSide && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-x-1 h-0.5 bg-accent", drag.dropSide === "before" ? "-top-px" : "-bottom-px")}
        />
      )}
      <span title={label} className="flex h-6 w-3.5 shrink-0 cursor-grab items-center justify-center text-fg-faint">
        <GripVertical aria-hidden className="h-3.5 w-3.5 opacity-0 group-hover/option:opacity-100" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** An option with the parent options it goes with (none: any; see lib/dependent-options). */
function withParents(option: SelectOption, ids: string[]): SelectOption {
  const { parentOptionIds: _old, ...rest } = option;
  return ids.length ? { ...rest, parentOptionIds: ids } : rest;
}

/** Makes a one-way relation two-way: "Show on <related database> too". */
function TwoWayItem({ prop, onClick }: { prop: Property; onClick: () => void }) {
  const t = useTranslations("database.relation");
  const tc = useTranslations("common");
  const target = useRelations()?.targets[prop.id];
  if (!target?.database) return null;
  return (
    <MenuItem icon={<ArrowLeftRight className="h-3.5 w-3.5" />} title={t("twoWayHint")} onClick={onClick}>
      {t("twoWay", { title: pageLabel(target.database.title, tc("untitled")) })}
    </MenuItem>
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
