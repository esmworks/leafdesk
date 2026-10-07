"use client";

import { Check, Copy, RefreshCw, Search, Send, Trash2, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";
import {
  createAutomationAction,
  rotateAutomationSecretAction,
  testAutomationWebhooksAction,
  updateAutomationAction,
} from "@/app/actions/automations";
import { copyText } from "@/components/settings/copy-button";
import { Button, cn, IconButton, Input, Switch } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import {
  isDynamicValue,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_WEBHOOK_URL,
  TO_VALUE_TYPES,
  WEBHOOK_SIGNATURE_HEADER,
  type AutomationActionType,
} from "@/lib/automations";
import { searchFold } from "@/lib/search-fold";
import {
  canSet,
  canWatch,
  draftProblem,
  emptyDraft,
  initialValue,
  namesPeopleType,
  newKey,
  optionsOf,
  toDraft,
  toInput,
  webhookUrls,
  type AgentChoice,
  type Automation,
  type Draft,
  type DraftAction,
  type DraftTrigger,
  type Person,
  type SetEntry,
} from "./automations-shared";
import { OptionChip } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

export const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

const MAX_CANDIDATES = 8;

/** The new-automation and edit form, with a saved automation's webhook secret and test. */
export function AutomationEditor({
  workspaceId,
  databaseId,
  saved,
  people,
  agents,
  isOwner,
  onSaved,
  onUpdated,
  onCancel,
}: {
  workspaceId: string;
  databaseId: string;
  /** The automation being edited; null for a new one. */
  saved: Automation | null;
  people: Person[];
  /** The agents a "Run an agent" action can pick; `isOwner`: the viewer can make one. */
  agents: AgentChoice[];
  isOwner: boolean;
  /** After a save: the automation as stored, and whether it was just created. */
  onSaved: (automation: Automation, created: boolean) => void;
  /** A new secret replaced the old one. */
  onUpdated: (automation: Automation) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const properties = useSchema();
  const [draft, setDraft] = useState<Draft>(() => (saved ? toDraft(saved, properties) : emptyDraft()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setTrigger = (trigger: DraftTrigger) => setDraft((d) => ({ ...d, trigger }));
  const setAction = (key: string, next: DraftAction) =>
    setDraft((d) => ({ ...d, actions: d.actions.map((a) => (a.key === key ? next : a)) }));
  const removeAction = (key: string) => setDraft((d) => ({ ...d, actions: d.actions.filter((a) => a.key !== key) }));
  const addAction = (type: AutomationActionType) =>
    setDraft((d) => ({
      ...d,
      actions: [
        ...d.actions,
        type === "set_properties"
          ? { key: newKey(), type, entries: [] }
          : type === "notify"
            ? { key: newKey(), type, people: [], properties: [] }
            : type === "run_agent"
              ? { key: newKey(), type, agentId: "", prompt: "" }
              : { key: newKey(), type, url: "" },
      ],
    }));

  const save = async () => {
    const problem = draftProblem(draft, properties);
    if (problem) {
      setError(t(`form.errors.${problem}`));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = toInput(draft);
      const res = saved ? await updateAutomationAction(saved.id, input) : await createAutomationAction(databaseId, input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onSaved(res.data, !saved);
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  const full = draft.actions.length >= MAX_AUTOMATION_ACTIONS;

  return (
    <>
      <div className={cn("max-h-[65vh] overflow-y-auto px-5 py-4", saving && "pointer-events-none opacity-70")}>
        <Field label={t("form.name")}>
          <Input
            value={draft.name}
            maxLength={MAX_AUTOMATION_NAME}
            autoFocus={!saved}
            placeholder={t("form.namePlaceholder")}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>

        <Section title={t("form.when")}>
          <TriggerEditor trigger={draft.trigger} people={people} onChange={setTrigger} />
        </Section>

        <Section title={t("form.then")}>
          <ol className="space-y-2">
            {draft.actions.map((action) => (
              <li key={action.key} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium">{t(`form.actionType.${action.type}`)}</span>
                  <IconButton label={t("form.removeAction")} onClick={() => removeAction(action.key)} className="hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
                {action.type === "set_properties" ? (
                  <SetPropertiesEditor action={action} people={people} onChange={(next) => setAction(action.key, next)} />
                ) : action.type === "notify" ? (
                  <NotifyEditor action={action} people={people} onChange={(next) => setAction(action.key, next)} />
                ) : action.type === "webhook" ? (
                  <Input
                    type="url"
                    inputMode="url"
                    value={action.url}
                    maxLength={MAX_WEBHOOK_URL}
                    aria-label={t("form.webhookUrl")}
                    placeholder={t("form.webhookPlaceholder")}
                    onChange={(e) => setAction(action.key, { ...action, url: e.target.value })}
                  />
                ) : (
                  <RunAgentEditor
                    workspaceId={workspaceId}
                    action={action}
                    agents={agents}
                    isOwner={isOwner}
                    onChange={(next) => setAction(action.key, next)}
                  />
                )}
              </li>
            ))}
          </ol>
          <div className="mt-2">
            <select
              value=""
              disabled={full}
              aria-label={t("form.addAction")}
              title={full ? t("form.maxActions", { max: MAX_AUTOMATION_ACTIONS }) : undefined}
              onChange={(e) => e.target.value && addAction(e.target.value as AutomationActionType)}
              className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none disabled:opacity-50"
            >
              <option value="">+ {t("form.addAction")}</option>
              <option value="set_properties">{t("form.actionType.set_properties")}</option>
              <option value="notify">{t("form.actionType.notify")}</option>
              <option value="webhook">{t("form.actionType.webhook")}</option>
              <option value="run_agent">{t("form.actionType.run_agent")}</option>
            </select>
          </div>
        </Section>

        {draft.actions.some((a) => a.type === "webhook") && (
          <Section title={t("webhook.title")}>
            {saved?.secret ? (
              <WebhookTools
                automation={saved}
                changed={webhookUrls(saved.actions) !== webhookUrls(draft.actions)}
                onUpdated={onUpdated}
              />
            ) : (
              <p className="text-xs text-fg-muted">{t("webhook.saveFirst")}</p>
            )}
          </Section>
        )}

        <label className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <span>{t("form.enabled")}</span>
          <Switch checked={draft.enabled} label={t("form.enabled")} onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
        </label>
        {saved?.runAs && <p className="mt-1 text-xs text-fg-faint">{t("form.runsAs", { name: saved.runAs.name || "?" })}</p>}
      </div>

      <Footer error={error}>
        <Button variant="ghost" onClick={onCancel}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? tc("saving") : saved ? tc("save") : t("form.create")}
        </Button>
      </Footer>
    </>
  );
}

export function Footer({ error, children }: { error?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
      {error && (
        <p role="alert" className="mr-auto text-xs text-danger">
          {error}
        </p>
      )}
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-2 text-xs font-medium text-fg-muted">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

/** "A row is added", or "a property (or any) changes", optionally "to" a value. */
function TriggerEditor({
  trigger,
  people,
  onChange,
}: {
  trigger: DraftTrigger;
  people: Person[];
  onChange: (trigger: DraftTrigger) => void;
}) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const watchable = properties.filter(canWatch);
  const propertyId = trigger.type === "property_changed" ? trigger.property : null;
  const prop = properties.find((p) => p.id === propertyId);
  const takesValue = !!prop && (TO_VALUE_TYPES as readonly string[]).includes(prop.type);
  const to = trigger.type === "property_changed" ? trigger.to : undefined;

  return (
    <div className="space-y-2">
      <select
        value={trigger.type}
        aria-label={t("form.when")}
        onChange={(e) =>
          onChange(e.target.value === "row_created" ? { type: "row_created" } : { type: "property_changed", property: null })
        }
        className={selectClass}
      >
        <option value="row_created">{t("form.triggerType.row_created")}</option>
        <option value="property_changed">{t("form.triggerType.property_changed")}</option>
      </select>
      {trigger.type === "property_changed" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={propertyId ?? ""}
            aria-label={t("form.property")}
            onChange={(e) => onChange({ type: "property_changed", property: e.target.value || null })}
            className={selectClass}
          >
            <option value="">{t("form.anyProperty")}</option>
            {watchable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {propertyId && !prop && <option value={propertyId}>{t("deletedProperty")}</option>}
          </select>
          {takesValue && (
            <select
              value={to === undefined ? "" : String(to)}
              aria-label={t("form.becomes")}
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  type: "property_changed",
                  property: propertyId,
                  ...(v === "" ? {} : { to: prop.type === "checkbox" ? v === "true" : v }),
                });
              }}
              className={selectClass}
            >
              <option value="">{t("form.anyValue")}</option>
              {prop.type === "checkbox" ? (
                <>
                  <option value="true">{t("form.becomesValue", { value: t("checked") })}</option>
                  <option value="false">{t("form.becomesValue", { value: t("unchecked") })}</option>
                </>
              ) : prop.type === "person" ? (
                people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("form.becomesValue", { value: p.name || p.email || "?" })}
                  </option>
                ))
              ) : (
                optionsOf(prop).map((o) => (
                  <option key={o.id} value={o.id}>
                    {t("form.becomesValue", { value: o.name })}
                  </option>
                ))
              )}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

/** Pairs of a property and the value to set it to. */
function SetPropertiesEditor({
  action,
  people,
  onChange,
}: {
  action: Extract<DraftAction, { type: "set_properties" }>;
  people: Person[];
  onChange: (action: Extract<DraftAction, { type: "set_properties" }>) => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const properties = useSchema();
  const used = new Set(action.entries.map((e) => e.propertyId));
  const available = properties.filter((p) => canSet(p) && !used.has(p.id));
  const setEntry = (index: number, entry: SetEntry) =>
    onChange({ ...action, entries: action.entries.map((e, i) => (i === index ? entry : e)) });

  return (
    <div className="space-y-2">
      {action.entries.map((entry, index) => {
        const prop = properties.find((p) => p.id === entry.propertyId);
        if (!prop) return null;
        return (
          <div key={entry.propertyId} className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
            <span className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 text-sm sm:w-36">
              <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <span className="truncate">{prop.name}</span>
            </span>
            <div className="min-w-0 flex-1">
              <ValueEditor prop={prop} value={entry.value} people={people} onChange={(value) => setEntry(index, { ...entry, value })} />
            </div>
            <IconButton
              label={tc("remove")}
              onClick={() => onChange({ ...action, entries: action.entries.filter((_, i) => i !== index) })}
              className="mt-1 hover:text-danger"
            >
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        );
      })}
      {available.length > 0 && (
        <select
          value=""
          aria-label={t("form.addProperty")}
          onChange={(e) => {
            const prop = available.find((p) => p.id === e.target.value);
            if (prop) onChange({ ...action, entries: [...action.entries, { propertyId: prop.id, value: initialValue(prop) }] });
          }}
          className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
        >
          <option value="">+ {t("form.addProperty")}</option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** The value a "set properties" action gives one property. */
function ValueEditor({
  prop,
  value,
  people,
  onChange,
}: {
  prop: Property;
  value: unknown;
  people: Person[];
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("database.automations");
  const label = t("form.valueFor", { property: prop.name });

  switch (prop.type) {
    case "select":
    case "status":
      return (
        <select value={typeof value === "string" ? value : ""} aria-label={label} onChange={(e) => onChange(e.target.value)} className={selectClass}>
          <option value="">{t("form.choose")}</option>
          {optionsOf(prop).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const options = optionsOf(prop);
      const rest = options.filter((o) => !ids.includes(o.id));
      return (
        <div className="flex min-h-8 flex-wrap items-center gap-1">
          {ids.map((id) => {
            const option = options.find((o) => o.id === id);
            return option ? <OptionChip key={id} option={option} onRemove={() => onChange(ids.filter((x) => x !== id))} /> : null;
          })}
          {rest.length > 0 && (
            <select
              value=""
              aria-label={label}
              onChange={(e) => e.target.value && onChange([...ids, e.target.value])}
              className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
            >
              <option value="">+ {t("form.addOption")}</option>
              {rest.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    case "checkbox":
      return (
        <div className="flex h-8 items-center gap-2 text-sm">
          <Switch checked={value === true} label={label} onChange={onChange} />
          <span className="text-fg-muted">{value === true ? t("checked") : t("unchecked")}</span>
        </div>
      );
    case "date": {
      const now = isDynamicValue(value) && value.$ === "now";
      return (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <select
            value={now ? "now" : "date"}
            aria-label={label}
            onChange={(e) => onChange(e.target.value === "now" ? { $: "now" } : "")}
            className={selectClass}
          >
            <option value="now">{t("form.now")}</option>
            <option value="date">{t("form.specificDate")}</option>
          </select>
          {!now && (
            <Input
              type="date"
              aria-label={label}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              className="[color-scheme:light_dark]"
            />
          )}
        </div>
      );
    }
    case "person": {
      const actor = isDynamicValue(value) && value.$ === "actor";
      return (
        <div className="space-y-1.5">
          <select
            value={actor ? "actor" : "people"}
            aria-label={label}
            onChange={(e) => onChange(e.target.value === "actor" ? { $: "actor" } : [])}
            className={selectClass}
          >
            <option value="actor">{t("form.actor")}</option>
            <option value="people">{t("form.specificPeople")}</option>
          </select>
          {!actor && (
            <PeoplePicker people={people} selected={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
          )}
        </div>
      );
    }
    default:
      return (
        <Input
          type={prop.type === "number" ? "number" : prop.type === "url" ? "url" : prop.type === "email" ? "email" : prop.type === "phone" ? "tel" : "text"}
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/**
 * The agent to run and the task it gets for this automation, or, with no agent yet, where owners
 * make one. Saving shares the database with the agent (edit), so it can change the row.
 */
function RunAgentEditor({
  workspaceId,
  action,
  agents,
  isOwner,
  onChange,
}: {
  workspaceId: string;
  action: Extract<DraftAction, { type: "run_agent" }>;
  agents: AgentChoice[];
  isOwner: boolean;
  onChange: (action: Extract<DraftAction, { type: "run_agent" }>) => void;
}) {
  const t = useTranslations("database.automations.form");
  const chosen = agents.find((a) => a.id === action.agentId);
  if (!agents.length && !action.agentId) {
    return (
      <p className="text-sm text-fg-muted">
        {t("noAgents")}{" "}
        {isOwner ? (
          <Link href={`/w/${workspaceId}/settings?tab=agents`} className="text-fg underline underline-offset-2 hover:text-accent">
            {t("createAgent")}
          </Link>
        ) : (
          t("noAgentsMember")
        )}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <select
        value={action.agentId}
        aria-label={t("agent")}
        onChange={(e) => onChange({ ...action, agentId: e.target.value })}
        className={selectClass}
      >
        <option value="">{t("chooseAgent")}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.icon ? `${a.icon} ` : ""}
            {a.enabled ? a.name : t("pausedAgent", { name: a.name })}
          </option>
        ))}
        {action.agentId && !chosen && <option value={action.agentId}>{t("archivedAgent")}</option>}
      </select>
      {chosen?.description && <p className="text-xs text-fg-muted">{chosen.description}</p>}
      <label className="block">
        <span className="mb-1 flex items-baseline justify-between gap-2 text-xs text-fg-muted">
          {t("agentTask")}
          <span className="tabular-nums text-fg-faint">
            {action.prompt.length} / {MAX_AGENT_PROMPT}
          </span>
        </span>
        <textarea
          rows={3}
          value={action.prompt}
          maxLength={MAX_AGENT_PROMPT}
          placeholder={t("agentTaskPlaceholder")}
          onChange={(e) => onChange({ ...action, prompt: e.target.value })}
          className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
        />
      </label>
      <p className="text-xs text-fg-faint">{chosen ? t("agentAccess", { agent: chosen.name }) : t("agentAccessAny")}</p>
    </div>
  );
}

/** Who a notification goes to: chosen people and the people a row's person properties name. */
function NotifyEditor({
  action,
  people,
  onChange,
}: {
  action: Extract<DraftAction, { type: "notify" }>;
  people: Person[];
  onChange: (action: Extract<DraftAction, { type: "notify" }>) => void;
}) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const personProperties = properties.filter((p) => namesPeopleType(p.type));
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs text-fg-muted">{t("form.people")}</p>
        <PeoplePicker people={people} selected={action.people} onChange={(ids) => onChange({ ...action, people: ids })} />
      </div>
      {personProperties.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-fg-muted">{t("form.personProperties")}</p>
          <ul className="space-y-0.5">
            {personProperties.map((p) => {
              const on = action.properties.includes(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-bg-hover">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        onChange({
                          ...action,
                          properties: on ? action.properties.filter((id) => id !== p.id) : [...action.properties, p.id],
                        })
                      }
                      className="accent-[var(--accent)]"
                    />
                    <PropertyTypeIcon type={p.type} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{p.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Chosen people as chips, and a search box to add more (as in the property access dialog). */
function PeoplePicker({
  people,
  selected,
  onChange,
}: {
  people: Person[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const candidates = useMemo(() => {
    if (!searching) return [];
    const q = searchFold(query.trim());
    return people
      .filter((p) => !selected.includes(p.id))
      .filter((p) => !q || searchFold(p.name).includes(q) || (p.email !== null && searchFold(p.email).includes(q)))
      .slice(0, MAX_CANDIDATES);
  }, [people, selected, query, searching]);
  const add = (id: string) => {
    onChange([...selected, id]);
    setQuery("");
  };

  return (
    <div>
      {selected.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((id) => {
            const person = people.find((p) => p.id === id);
            const name = person?.name || person?.email || t("unknownPerson");
            return (
              <li key={id} className="inline-flex items-center gap-1 rounded-md bg-bg-hover py-0.5 pr-1 pl-0.5 text-sm">
                {person ? (
                  <UserAvatar name={name} image={person.image} size="xs" colors="bg-accent/15 text-accent" />
                ) : (
                  <UserRound className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
                )}
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`${tc("remove")}: ${name}`}
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  className="rounded text-fg-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
        <Search className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearching(true)}
          onBlur={() => setSearching(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (candidates[0]) add(candidates[0].id);
            }
          }}
          placeholder={t("form.addPerson")}
          aria-label={t("form.addPerson")}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </label>
      {searching && (
        <div className="mt-1 rounded-lg border border-border p-1">
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              // Keeps the search box focused, so the list stays open for the next pick.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover"
            >
              <UserAvatar name={p.name || p.email || "?"} image={p.image} size="md" colors="bg-accent/15 text-accent" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{p.name || p.email}</span>
                {p.email && p.name && <span className="block truncate text-xs text-fg-muted">{p.email}</span>}
              </span>
            </button>
          ))}
          {!candidates.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("form.noMatches")}</p>}
        </div>
      )}
    </div>
  );
}

type TestResult = { url: string; ok: boolean; httpStatus?: number; code?: string; error?: string };

/** A saved automation's signing secret (copy, replace) and a test delivery to its webhooks. */
function WebhookTools({
  automation,
  changed,
  onUpdated,
}: {
  automation: Automation;
  /** The form's addresses differ from the saved ones, which the test goes to. */
  changed: boolean;
  onUpdated: (automation: Automation) => void;
}) {
  const t = useTranslations("database.automations.webhook");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"rotate" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const secret = automation.secret ?? "";

  const rotate = async () => {
    if (!confirm(t("confirmRotate"))) return;
    setBusy("rotate");
    setError(null);
    try {
      const res = await rotateAutomationSecretAction(automation.id);
      if (res.ok) onUpdated(res.data);
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setResults(null);
    try {
      const res = await testAutomationWebhooksAction(automation.id);
      if (res.ok) setResults(res.data);
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <span className="block text-xs text-fg-muted">{t("secret")}</span>
      <div className="flex items-center gap-1.5">
        <Input readOnly value={secret} aria-label={t("secret")} onFocus={(e) => e.currentTarget.select()} />
        <Button
          size="sm"
          className="shrink-0"
          onClick={async (e) => {
            if (await copyText(secret, e.currentTarget)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </div>
      <p className="text-xs text-fg-faint">{t("signatureHelp", { header: WEBHOOK_SIGNATURE_HEADER, signed: "<t>.<body>" })}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" disabled={busy !== null} onClick={() => void rotate()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("rotate")}
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void test()}>
          <Send className="h-3.5 w-3.5" />
          {busy === "test" ? t("testing") : t("test")}
        </Button>
      </div>
      {changed && <p className="text-xs text-fg-faint">{t("testSavedOnly")}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {results && (
        <ul className="space-y-1" aria-live="polite">
          {!results.length && <li className="text-xs text-fg-muted">{t("noWebhooks")}</li>}
          {results.map((r, i) => (
            <li key={`${r.url}-${i}`} className="text-xs">
              <span className="block truncate text-fg-muted" title={r.url}>
                {r.url}
              </span>
              <span className={r.ok ? "text-fg" : "text-danger"} title={r.error}>
                {r.ok
                  ? t("testOk", { status: String(r.httpStatus ?? "") })
                  : t("testFailed", {
                      reason: [r.code, r.httpStatus ? `HTTP ${r.httpStatus}` : null, r.error].filter(Boolean).join(" · "),
                    })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
