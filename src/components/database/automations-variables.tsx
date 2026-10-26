"use client";

import { Braces, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { cn, IconButton, Input, textareaClass } from "@/components/ui";
import { templateFor } from "@/lib/automation-templates";
import { hasRow } from "@/lib/automations";
import { searchFold } from "@/lib/search-fold";
import { forEachOfDraft, parseJson, targetDatabase, type Draft } from "./automations-shared";
import { Floating, useFloating } from "./floating";
import type { Property } from "./types";

/**
 * The variable picker: next to every text a step writes templates into, a button that lists what
 * the step can use (the trigger's fields, what earlier steps gave and, going "for each", the
 * found row) and writes the chosen one in at the cursor as `{{…}}`.
 */

export type Variable = { label: string; template: string };
export type VariableGroup = { label: string; items: Variable[] };

const VariablesContext = createContext<VariableGroup[]>([]);
export const VariablesProvider = VariablesContext.Provider;

/** At most this many fields of an example body are offered. */
const MAX_EXAMPLE_FIELDS = 40;

/** The paths into an example body: its fields, nested ones too, and a list's first item. */
function examplePaths(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = [], depth = 0): (string | number)[][] {
  if (out.length >= MAX_EXAMPLE_FIELDS || depth > 4) return out;
  if (Array.isArray(value)) {
    if (path.length) out.push(path);
    if (value.length) examplePaths(value[0], [...path, 0], out, depth + 1);
  } else if (value && typeof value === "object") {
    if (path.length) out.push(path);
    for (const [k, v] of Object.entries(value)) examplePaths(v, [...path, k], out, depth + 1);
  } else if (path.length) out.push(path);
  return out.slice(0, MAX_EXAMPLE_FIELDS);
}

const label = (path: (string | number)[]) => path.join(".");

/**
 * What the step at `index` can use. Row runs: the row's properties by name and its own fields;
 * a schedule's: when it was due; an incoming webhook's: the example body's fields. Then each
 * earlier step's output by its type, and the found row when the step goes "for each".
 */
export function useStepVariables(
  draft: Draft,
  index: number,
  properties: Property[],
  schemaOf: (databaseId: string) => Property[] | undefined,
  databaseId: string,
): VariableGroup[] {
  const t = useTranslations("database.automations.variables");
  const tType = useTranslations("database.automations.form.actionType");
  return useMemo(() => {
    const trigger = draft.trigger;
    const groups: VariableGroup[] = [];
    const v = (text: string, root: string, path: (string | number)[] = []): Variable => ({ label: text, template: templateFor(root, path) });
    const rowFields = (root: string, props: Property[] | undefined, extra: Variable[] = []) => [
      v(t("title"), root, ["title"]),
      v(t("url"), root, ["url"]),
      v(t("id"), root, ["id"]),
      ...(props ?? []).map((p) => v(p.name, root, [p.name])),
      ...extra,
    ];
    if (hasRow(trigger)) {
      const extra: Variable[] = [v(t("event"), "trigger", ["event"]), v(t("database"), "trigger", ["database", "title"])];
      if (trigger.type !== "date_passed") extra.push(v(t("actor"), "trigger", ["actor", "name"]));
      if (trigger.type === "date_passed") extra.push(v(t("date"), "trigger", ["date"]));
      if (trigger.type === "property_changed") {
        const watched = trigger.properties.length ? properties.filter((p) => trigger.properties.includes(p.id)) : [];
        for (const p of watched) {
          extra.push(v(t("before", { property: p.name }), "trigger", ["changes", p.name, "before"]));
          extra.push(v(t("after", { property: p.name }), "trigger", ["changes", p.name, "after"]));
        }
      }
      groups.push({ label: t("triggerRow"), items: rowFields("trigger", properties, extra) });
    } else if (trigger.type === "schedule") {
      groups.push({
        label: t("trigger"),
        items: [v(t("scheduledFor"), "trigger", ["scheduledFor"]), v(t("database"), "trigger", ["database", "title"]), v(t("databaseUrl"), "trigger", ["database", "url"])],
      });
    } else if (trigger.type === "view_threshold") {
      groups.push({
        label: t("trigger"),
        items: [
          v(t("value"), "trigger", ["value"]),
          v(t("threshold"), "trigger", ["threshold"]),
          v(t("previous"), "trigger", ["previous"]),
          v(t("viewName"), "trigger", ["view", "name"]),
          v(t("viewUrl"), "trigger", ["view", "url"]),
          v(t("database"), "trigger", ["database", "title"]),
          v(t("databaseUrl"), "trigger", ["database", "url"]),
        ],
      });
    } else if (trigger.type === "incoming_webhook") {
      const example = parseJson(trigger.example);
      const paths = example.ok ? examplePaths(example.value) : [];
      groups.push({ label: t("trigger"), items: [v(t("body"), "trigger"), ...paths.map((p) => v(label(p), "trigger", p))] });
    }
    for (const step of draft.actions.slice(0, index)) {
      const id = step.id;
      if (!id) continue;
      const items: Variable[] = [];
      switch (step.type) {
        case "http_request":
          items.push(v(t("status"), id, ["status"]), v(t("responseBody"), id, ["body"]), v(t("headers"), id, ["headers"]));
          break;
        case "find_rows": {
          const props = schemaOf(step.databaseId);
          items.push(
            v(t("count"), id, ["count"]),
            v(t("rows"), id, ["rows"]),
            v(t("firstTitle"), id, ["first", "title"]),
            v(t("firstUrl"), id, ["first", "url"]),
            ...(props ?? []).map((p) => v(t("first", { property: p.name }), id, ["first", p.name])),
          );
          break;
        }
        case "create_row":
        case "upsert_row":
          items.push(v(t("title"), id, ["title"]), v(t("url"), id, ["url"]), v(t("id"), id, ["id"]));
          if (step.type === "upsert_row") items.push(v(t("created"), id, ["created"]));
          break;
        case "log":
          items.push(v(t("message"), id, ["message"]));
          break;
        case "wait":
          items.push(v(t("until"), id, ["until"]));
          break;
        case "approval":
          items.push(v(t("approvedBy"), id, ["approved_by"]), v(t("answeredAt"), id, ["answered_at"]));
          break;
        case "notify":
          if (!step.forEach) items.push(v(t("notified"), id, ["notified"]));
          break;
        case "run_agent":
          if (!step.forEach) items.push(v(t("agentRunId"), id, ["agentRunId"]));
          break;
        case "set_properties":
          if (!step.forEach) items.push(v(t("rowId"), id, ["id"]));
          break;
        default:
          break;
      }
      if (items.length) groups.push({ label: t("step", { id, type: tType(step.type) }), items });
    }
    const action = draft.actions[index];
    if (action && forEachOfDraft(action)) {
      groups.push({ label: t("item"), items: rowFields("item", schemaOf(targetDatabase(draft.actions, action, databaseId))) });
    }
    return groups;
  }, [draft.trigger, draft.actions, index, properties, schemaOf, databaseId, t, tType]);
}

/** Whether `pos` in JSON text is inside a string (an odd number of unescaped quotes before it). */
function insideJsonString(text: string, pos: number) {
  let inside = false;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') inside = !inside;
  }
  return inside;
}

/** The button that opens the step's variables; picking one hands its template on. */
export function VariableButton({ onPick, className }: { onPick: (template: string) => void; className?: string }) {
  const t = useTranslations("database.automations.variables");
  const groups = useContext(VariablesContext);
  const menu = useFloating<HTMLButtonElement>();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = searchFold(query.trim());
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => searchFold(i.label).includes(q) || searchFold(i.template).includes(q)) }))
      .filter((g) => g.items.length);
  }, [groups, query]);
  return (
    <>
      <IconButton
        ref={menu.ref}
        label={t("button")}
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className={cn("h-8 w-8 border border-border", menu.open && "bg-bg-hover text-fg", className)}
      >
        <Braces className="h-3.5 w-3.5" />
      </IconButton>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end" className="w-80">
        <label className="mb-1 flex h-8 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
          />
        </label>
        <div className="max-h-72 overflow-y-auto" role="listbox" aria-label={t("button")}>
          {shown.map((group) => (
            <div key={group.label} className="py-1">
              <p className="px-2 pb-0.5 text-xs font-medium text-fg-muted">{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.template}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(item.template);
                    menu.close();
                    setQuery("");
                  }}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-start text-sm hover:bg-bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-fg-faint" dir="ltr">
                    {item.template}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!shown.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{groups.length ? t("noMatches") : t("none")}</p>}
        </div>
      </Floating>
    </>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** A textarea of this many rows instead of a line. */
  rows?: number;
  /** JSON text: a variable written outside a string goes in quotes. */
  json?: boolean;
};

/** A text field that takes templates, with the variable picker next to it. */
export function TemplateField({ value, onChange, rows, json = false, className, ...props }: FieldProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (template: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const text = json && !insideJsonString(value, start) ? `"${template}"` : template;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      {rows ? (
        <textarea
          ref={ref}
          rows={rows}
          value={value}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          aria-label={props["aria-label"]}
          readOnly={props.readOnly}
          spellCheck={json ? false : undefined}
          dir={json ? "ltr" : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn(textareaClass, className)}
        />
      ) : (
        <Input ref={ref} {...props} value={value} onChange={(e) => onChange(e.target.value)} className={className} />
      )}
      {!props.readOnly && <VariableButton onPick={insert} />}
    </div>
  );
}
