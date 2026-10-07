"use client";

import { ArrowLeft, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { builtinAgentPropertiesAction, installBuiltinAgentAction } from "@/app/actions/agents";
import { PropertyTypeIcon } from "@/components/database/property-icons";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, Input, PageIcon, pageLabel } from "@/components/ui";
import { MAX_AGENT_NAME, type AgentView } from "@/lib/agents";
import {
  ANSWER_PROPERTY_TYPES,
  FLAG_PROPERTY_TYPES,
  MAX_KNOWLEDGE_PAGES,
  MAX_ROUTER_PROPERTIES,
  MAX_ROUTER_RULES,
  NEW_PROPERTY,
  ROUTER_PROPERTY_TYPES,
  type BuiltinAgentSetup,
  type BuiltinAgentSummary,
} from "@/lib/builtin-agents";
import { Field, textareaClass } from "./agent-dialog";
import { PagePicker, useShareablePages, type PickablePage } from "./agent-page-picker";

type WizardProperty = { id: string; name: string; type: string; options: { id: string; name: string }[] };
type Step = "database" | "properties" | "pages";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Sets up a built-in agent: the database it works on, the properties it uses there (existing
 * ones of the right type, or a new one it brings), for the answerer the pages it reads, and its
 * name. Creating it adds the agent and the automation that runs it on every new row.
 */
export function TemplateWizard({
  workspaceId,
  template,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  template: BuiltinAgentSummary;
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
}) {
  const t = useTranslations("settings.agents.wizard");
  const tc = useTranslations("common");
  const pages = useShareablePages(workspaceId);
  const [step, setStep] = useState<Step>("database");
  const [database, setDatabase] = useState<PickablePage | null>(null);
  const [properties, setProperties] = useState<WizardProperty[] | null>(null);
  const [routed, setRouted] = useState<string[]>([]);
  const [rules, setRules] = useState("");
  const [property, setProperty] = useState("");
  const [answered, setAnswered] = useState("");
  const [needsPerson, setNeedsPerson] = useState("");
  const [knowledge, setKnowledge] = useState<string[]>([]);
  const [name, setName] = useState(template.name);
  const [problem, setProblem] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  const own = template.newProperty;
  const answerer = template.key === "request-answerer";
  const last: Step = answerer ? "pages" : "properties";

  const eligible = (types: readonly string[]) => (properties ?? []).filter((p) => types.includes(p.type));

  /** Options for the answerer's two outcomes: one with the template's name, or a new one. */
  const pickOptions = (prop: WizardProperty | undefined) => {
    const match = (wanted: string) => prop?.options.find((o) => sameName(o.name, wanted))?.id ?? NEW_PROPERTY;
    setAnswered(match(own.options[0]));
    setNeedsPerson(match(own.options[1]));
  };

  const chooseDatabase = (page: PickablePage) => {
    setDatabase(page);
    setProblem(null);
    run(
      () => builtinAgentPropertiesAction(workspaceId, page.id),
      (loaded) => {
        setProperties(loaded);
        // Defaults: a property named like the template's own, else the first that fits, else a new one.
        const types = template.key === "duplicate-finder" ? FLAG_PROPERTY_TYPES : ANSWER_PROPERTY_TYPES;
        const fits = loaded.filter((p) => (types as readonly string[]).includes(p.type));
        const preferred = fits.find((p) => sameName(p.name, own.name)) ?? fits[0];
        setProperty(preferred?.id ?? NEW_PROPERTY);
        pickOptions(preferred);
        const routable = loaded.filter((p) => (ROUTER_PROPERTY_TYPES as readonly string[]).includes(p.type) && (p.type === "person" || p.options.length));
        setRouted(routable.length ? [] : [NEW_PROPERTY]);
        setStep("properties");
      },
    );
  };

  /** What the current step is missing, as a message key. */
  const missing = (): "needProperty" | "needRules" | "sameOptions" | "needPages" | "needName" | null => {
    if (step === "properties") {
      if (template.key === "ticket-router") {
        if (!routed.length) return "needProperty";
        if (!rules.trim()) return "needRules";
      } else if (!property) return "needProperty";
      if (answerer && property !== NEW_PROPERTY && answered !== NEW_PROPERTY && answered === needsPerson) return "sameOptions";
    }
    if (step === "pages" && !knowledge.length) return "needPages";
    if (step === last && !name.trim()) return "needName";
    return null;
  };

  const next = () => {
    const key = missing();
    setProblem(key && t(`errors.${key}`));
    if (key) return;
    if (step !== last) {
      setStep("pages");
      return;
    }
    if (!database) return;
    const base = { databaseId: database.id, name: name.trim() };
    const setup: BuiltinAgentSetup =
      template.key === "ticket-router"
        ? { ...base, key: template.key, properties: routed, rules }
        : template.key === "request-answerer"
          ? { ...base, key: template.key, property, answered, needsPerson, pages: knowledge }
          : { ...base, key: template.key, property };
    run(() => installBuiltinAgentAction(workspaceId, setup), (result) => onCreated(result.agent));
  };

  const back = () => {
    setProblem(null);
    setStep(step === "pages" ? "properties" : "database");
  };

  const databases = pages && pages.filter((p) => p.kind === "database");
  const knowledgePages = pages && pages.filter((p) => p.id !== database?.id);
  const answerProp = properties?.find((p) => p.id === property);

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {step !== "database" && (
          <IconButton label={t("back")} onClick={back} className="mt-1">
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        )}
        <span className="mt-0.5 text-lg leading-none">{template.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{t("title", { name: template.name })}</h2>
          <p className="truncate text-sm text-fg-muted">
            {t(`steps.${step}`)}
            {database && step !== "database" && ` · ${pageLabel(database.title, tc("untitled"))}`}
          </p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "pointer-events-none opacity-70")}>
        {step === "database" && (
          <>
            <p className="text-sm text-fg-muted">{t("chooseDatabase")}</p>
            <PagePicker autoFocus pages={databases} label={t("searchDatabases")} empty={t("noDatabases")} onPick={chooseDatabase} />
          </>
        )}

        {step === "properties" && properties && (
          <>
            {template.key === "ticket-router" && (
              <>
                <Field label={t("routerProperties")} help={t("routerPropertiesHelp", { max: MAX_ROUTER_PROPERTIES })}>
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {eligible(ROUTER_PROPERTY_TYPES).map((p) => {
                      const empty = p.type !== "person" && !p.options.length;
                      return (
                        <PropertyChoice
                          key={p.id}
                          type={p.type}
                          name={p.name}
                          hint={p.type === "person" ? t("anyPerson") : empty ? t("noOptions") : p.options.map((o) => o.name).join(", ")}
                          checked={routed.includes(p.id)}
                          disabled={empty || (!routed.includes(p.id) && routed.length >= MAX_ROUTER_PROPERTIES)}
                          onChange={(on) => setRouted((r) => (on ? [...r, p.id] : r.filter((id) => id !== p.id)))}
                        />
                      );
                    })}
                    <PropertyChoice
                      type={own.type}
                      name={t("newProperty", { name: own.name })}
                      hint={own.options.join(", ")}
                      checked={routed.includes(NEW_PROPERTY)}
                      disabled={!routed.includes(NEW_PROPERTY) && routed.length >= MAX_ROUTER_PROPERTIES}
                      onChange={(on) => setRouted((r) => (on ? [...r, NEW_PROPERTY] : r.filter((id) => id !== NEW_PROPERTY)))}
                    />
                  </ul>
                </Field>
                <label className="block">
                  <span className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium text-fg-muted">
                    {t("rules")}
                    <span className="font-normal tabular-nums text-fg-faint">{rules.length} / {MAX_ROUTER_RULES}</span>
                  </span>
                  <textarea
                    rows={6}
                    value={rules}
                    maxLength={MAX_ROUTER_RULES}
                    placeholder={t("rulesPlaceholder")}
                    onChange={(e) => setRules(e.target.value)}
                    className={textareaClass}
                  />
                  <span className="mt-1 block text-xs text-fg-muted">{t("rulesHelp")}</span>
                </label>
              </>
            )}

            {template.key !== "ticket-router" && (
              <Field label={t(answerer ? "answerProperty" : "flagProperty")} help={t(answerer ? "answerPropertyHelp" : "flagPropertyHelp")}>
                <select
                  value={property}
                  aria-label={t(answerer ? "answerProperty" : "flagProperty")}
                  onChange={(e) => {
                    setProperty(e.target.value);
                    pickOptions(properties.find((p) => p.id === e.target.value));
                  }}
                  className={selectClass}
                >
                  {eligible(answerer ? ANSWER_PROPERTY_TYPES : FLAG_PROPERTY_TYPES).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={NEW_PROPERTY}>{t("newProperty", { name: own.name })}</option>
                </select>
              </Field>
            )}

            {answerer && answerProp && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["answered", answered, setAnswered, own.options[0]],
                    ["needsPerson", needsPerson, setNeedsPerson, own.options[1]],
                  ] as const
                ).map(([key, value, set, fallback]) => (
                  <Field key={key} label={t(key)}>
                    <select value={value} aria-label={t(key)} onChange={(e) => set(e.target.value)} className={selectClass}>
                      {answerProp.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                      <option value={NEW_PROPERTY}>{t("newOption", { name: fallback })}</option>
                    </select>
                  </Field>
                ))}
              </div>
            )}
            {answerer && property === NEW_PROPERTY && (
              <p className="text-xs text-fg-muted">{t("newOptionsNote", { answered: own.options[0], needsPerson: own.options[1] })}</p>
            )}
          </>
        )}

        {step === "pages" && (
          <Field label={t("knowledge")} help={t("knowledgeHelp", { max: MAX_KNOWLEDGE_PAGES })}>
            {knowledge.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-1">
                {knowledge.map((id) => {
                  const page = pages?.find((p) => p.id === id);
                  const title = pageLabel(page?.title ?? "", tc("untitled"));
                  return (
                    <li key={id} className="inline-flex items-center gap-1 rounded-md bg-bg-hover py-0.5 pr-1 pl-1.5 text-sm">
                      <PageIcon icon={page?.icon ?? null} kind={page?.kind} className="text-xs" />
                      <span className="max-w-48 truncate">{title}</span>
                      <button
                        type="button"
                        aria-label={`${tc("remove")}: ${title}`}
                        onClick={() => setKnowledge((k) => k.filter((x) => x !== id))}
                        className="rounded text-fg-muted hover:text-danger"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <PagePicker
              pages={knowledgePages}
              label={t("searchPages")}
              empty={t("noPages")}
              selected={knowledge}
              onPick={(page) =>
                setKnowledge((k) => (k.includes(page.id) ? k.filter((id) => id !== page.id) : k.length < MAX_KNOWLEDGE_PAGES ? [...k, page.id] : k))
              }
            />
          </Field>
        )}

        {step === last && properties && (
          <div className="space-y-3 border-t border-border pt-4">
            <Field label={t("name")}>
              <Input value={name} maxLength={MAX_AGENT_NAME} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p className="text-xs text-fg-muted">
              {t("summary", { database: pageLabel(database?.title ?? "", tc("untitled")) })}
              {answerer && ` ${t("summaryPages")}`}
            </p>
          </div>
        )}
      </div>

      {step !== "database" && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {(problem || error) && (
            <p role="alert" className="mr-auto text-xs text-danger">
              {problem ?? error}
            </p>
          )}
          <Button variant="ghost" onClick={back}>
            {t("back")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={next}>
            {step === last ? (pending ? t("creating") : t("create")) : t("next")}
          </Button>
        </div>
      )}
      {step === "database" && error && (
        <p role="alert" className="border-t border-border px-5 py-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** A property the agent may use, ticked on or off. */
function PropertyChoice({
  type,
  name,
  hint,
  checked,
  disabled,
  onChange,
}: {
  type: string;
  name: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const tt = useTranslations("database.types");
  const label = (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <PropertyTypeIcon type={type as "select"} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-xs text-fg-faint">{tt(type as "select")}</span>
      </span>
      {hint && <span className="block truncate text-xs text-fg-muted">{hint}</span>}
    </span>
  );
  return (
    <li>
      <label className={cn("flex items-center gap-2.5 px-3 py-1.5 text-sm", disabled ? "opacity-50" : "cursor-pointer hover:bg-bg-hover")}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
        {label}
      </label>
    </li>
  );
}
