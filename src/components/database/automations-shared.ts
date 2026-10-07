import type { listAutomationRunsAction, listAutomationsAction } from "@/app/actions/automations";
import { isDynamicValue, UNSETTABLE_TYPES, type AutomationAction, type AutomationTrigger } from "@/lib/automations";
import type { Property, SelectOption } from "./types";

type Ok<T> = T extends { ok: true; data: infer D } ? D : never;

export type AutomationsData = Ok<Awaited<ReturnType<typeof listAutomationsAction>>>;
export type Automation = AutomationsData["automations"][number];
export type AutomationRun = Ok<Awaited<ReturnType<typeof listAutomationRunsAction>>>[number];

/** Someone an automation can notify or assign: the workspace's people. */
export type Person = { id: string; name: string; email: string | null; image?: string | null };

/** Property types the editor can set a value of (relations, files and checklists stay out for now). */
export const EDITABLE_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "person",
] as const;

export const canSet = (prop: Property) => (EDITABLE_TYPES as readonly string[]).includes(prop.type);

/** Properties a trigger can watch: the ones a row write changes (not computed ones). */
export const canWatch = (prop: Property) => !(UNSETTABLE_TYPES as readonly string[]).includes(prop.type);

/** People properties a notification can go to (see holdsPeople). */
export const namesPeopleType = (type: string) => type === "person" || type === "created_by" || type === "last_edited_by";

export const optionsOf = (prop: Property | undefined): SelectOption[] => prop?.options?.options ?? [];

/** One value of a "set properties" action, as edited. */
export type SetEntry = { propertyId: string; value: unknown };

export type DraftAction =
  | { key: string; type: "set_properties"; entries: SetEntry[] }
  | { key: string; type: "notify"; people: string[]; properties: string[] }
  | { key: string; type: "webhook"; url: string }
  | { key: string; type: "run_agent"; agentId: string; prompt: string };

export type DraftTrigger =
  | { type: "row_created" }
  | { type: "property_changed"; property: string | null; to?: string | boolean };

export type Draft = { name: string; enabled: boolean; trigger: DraftTrigger; actions: DraftAction[] };

let keys = 0;
export const newKey = () => `a${++keys}`;

/** The editor's starting value for a property set to something. */
export function initialValue(prop: Property): unknown {
  switch (prop.type) {
    case "checkbox":
      return true;
    case "date":
      return { $: "now" };
    case "person":
    case "multi_select":
      return [];
    default:
      return "";
  }
}

/** A stored automation as the editor edits it; values of deleted properties are left out. */
export function toDraft(automation: Automation, properties: Property[]): Draft {
  const has = (id: string) => properties.some((p) => p.id === id);
  const trigger: DraftTrigger =
    automation.trigger.type === "row_created"
      ? { type: "row_created" }
      : {
          type: "property_changed",
          property: automation.trigger.propertyId,
          ...(automation.trigger.to !== undefined && automation.trigger.to !== null ? { to: automation.trigger.to } : {}),
        };
  const actions = automation.actions.map((action): DraftAction => {
    if (action.type === "set_properties") {
      return {
        key: newKey(),
        type: "set_properties",
        entries: Object.entries(action.values)
          .filter(([id]) => has(id))
          .map(([propertyId, value]) => ({
            propertyId,
            value: typeof value === "number" ? String(value) : value,
          })),
      };
    }
    if (action.type === "notify") {
      return { key: newKey(), type: "notify", people: action.userIds, properties: action.propertyIds.filter(has) };
    }
    if (action.type === "run_agent") return { key: newKey(), type: "run_agent", agentId: action.agentId, prompt: action.prompt };
    return { key: newKey(), type: "webhook", url: action.url };
  });
  return { name: automation.name, enabled: automation.enabled, trigger, actions };
}

export const emptyDraft = (): Draft => ({
  name: "",
  enabled: true,
  trigger: { type: "row_created" },
  actions: [{ key: newKey(), type: "notify", people: [], properties: [] }],
});

/** What a draft is missing before it can be saved, as a message key of `automations.form.errors`. */
export function draftProblem(draft: Draft, properties: Property[]) {
  if (!draft.name.trim()) return "needName";
  if (!draft.actions.length) return "needAction";
  for (const action of draft.actions) {
    if (action.type === "set_properties") {
      if (!action.entries.length) return "needProperty";
      for (const { propertyId, value } of action.entries) {
        const prop = properties.find((p) => p.id === propertyId);
        if (!prop) return "needProperty";
        if (isDynamicValue(value)) continue;
        const empty = Array.isArray(value) ? !value.length : value === "" || value === null || value === undefined;
        if (empty && ["select", "status", "multi_select", "person", "date", "number"].includes(prop.type)) return "needValue";
      }
    } else if (action.type === "notify") {
      if (!action.people.length && !action.properties.length) return "needPeople";
    } else if (action.type === "run_agent") {
      if (!action.agentId) return "needAgent";
    } else if (!action.url.trim()) return "needUrl";
  }
  return null;
}

/** A draft as the server takes it (properties and people by id). */
export function toInput(draft: Draft) {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    trigger:
      draft.trigger.type === "row_created"
        ? { type: "row_created" as const }
        : { type: "property_changed" as const, property: draft.trigger.property, to: draft.trigger.to ?? null },
    actions: draft.actions.map((action) => {
      if (action.type === "set_properties") {
        return {
          type: "set_properties" as const,
          values: Object.fromEntries(action.entries.map((e) => [e.propertyId, typeof e.value === "string" ? e.value.trim() : e.value])),
        };
      }
      if (action.type === "notify") return { type: "notify" as const, people: action.people, properties: action.properties };
      if (action.type === "run_agent") return { type: "run_agent" as const, agent: action.agentId, prompt: action.prompt.trim() };
      return { type: "webhook" as const, url: action.url.trim() };
    }),
  };
}

/** The webhook addresses of a stored automation, to tell whether a draft changed them. */
export const webhookUrls = (actions: AutomationAction[] | DraftAction[]) =>
  actions.flatMap((a) => (a.type === "webhook" ? [a.url.trim()] : [])).join("\n");

/** The trigger's value as a word: an option's, a person's name, or checked/unchecked. */
export function triggerValueName(
  trigger: AutomationTrigger | DraftTrigger,
  prop: Property | undefined,
  people: Person[],
  checkedLabels: { checked: string; unchecked: string },
) {
  if (trigger.type !== "property_changed" || trigger.to === undefined || trigger.to === null) return null;
  if (typeof trigger.to === "boolean") return trigger.to ? checkedLabels.checked : checkedLabels.unchecked;
  if (prop?.type === "person") return people.find((p) => p.id === trigger.to)?.name ?? "?";
  return optionsOf(prop).find((o) => o.id === trigger.to)?.name ?? "?";
}
