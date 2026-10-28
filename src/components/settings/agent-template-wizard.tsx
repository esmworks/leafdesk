"use client";

import { ArrowLeft, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { builtinAgentPropertiesAction, installBuiltinAgentAction } from "@/app/actions/agents";
import { listConnectionsAction } from "@/app/actions/connections";
import { PropertyTypeIcon, usePropertyTypeLabel } from "@/components/database/property-icons";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton, Input, PageIcon, pageLabel, textareaClass } from "@/components/ui";
import { MAX_AGENT_NAME, type AgentView } from "@/lib/agents";
import {
  ANSWER_PROPERTY_TYPES,
  COMPANY_PROPERTY_TYPES,
  FLAG_PROPERTY_TYPES,
  isCompanyProperty,
  logPropertiesOf,
  MAX_COMPANY_PROPERTIES,
  MAX_KNOWLEDGE_PAGES,
  MAX_LOG_PROPERTIES,
  MAX_ROUTER_PROPERTIES,
  MAX_ROUTER_RULES,
  NEW_PROPERTY,
  ROUTER_PROPERTY_TYPES,
  type BuiltinAgentSetup,
  type BuiltinAgentSummary,
} from "@/lib/builtin-agents";
import { MAX_TRIGGER_EVENT, type ConnectionView, type EventPreset } from "@/lib/connections";
import { Field } from "./agent-dialog";
import { PagePicker, useShareablePages, type PickablePage } from "./agent-page-picker";

type WizardProperty = { id: string; name: string; type: string; options: { id: string; name: string }[]; description: string | null; ai: boolean };
type Step = "database" | "properties" | "pages";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type WizardProps = {
  workspaceId: string;
  template: BuiltinAgentSummary;
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
};

/**
 * Sets up a built-in agent: one an automation runs on new rows, one a connection's events run, or
 * the company researcher, which fills a database's own properties from the web.
 */
export function TemplateWizard(props: WizardProps) {
  const { template } = props;
  if (template.key === "company-details") return <CompanyDetailsWizard {...props} />;
  if (!template.newProperty) return <EventAgentWizard {...props} />;
  return <RowAgentWizard {...props} template={{ ...template, newProperty: template.newProperty }} />;
}

/**
 * The database it works on, the properties it uses there (existing ones of the right type, or a
 * new one it brings), for the answerer the pages it reads, and its name. Creating it adds the
 * agent and the automation that runs it on every new row.
 */
function RowAgentWizard({
  workspaceId,
  template,
  onClose,
  onCreated,
}: WizardProps & { template: { newProperty: NonNullable<BuiltinAgentSummary["newProperty"]> } }) {
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
  // Set once the owner tries to go on; what's missing then shows until it's filled in.
  const [tried, setTried] = useState(false);
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
    setTried(false);
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
    setTried(true);
    if (missing()) return;
    if (step !== last) {
      setTried(false);
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
          : { ...base, key: "duplicate-finder", property };
    run(() => installBuiltinAgentAction(workspaceId, setup), (result) => onCreated(result.agent));
  };

  const back = () => {
    setTried(false);
    setStep(step === "pages" ? "properties" : "database");
  };

  const gap = tried ? missing() : null;
  const problem = gap && t(`errors.${gap}`);

  const databases = pages && pages.filter((p) => p.kind === "database");
  const knowledgePages = pages && pages.filter((p) => p.id !== database?.id);
  const answerProp = properties?.find((p) => p.id === property);

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <WizardHeader
        template={template}
        step={
          <>
            {t(`steps.${step}`)}
            {database && step !== "database" && ` · ${pageLabel(database.title, tc("untitled"))}`}
          </>
        }
        onBack={step !== "database" ? back : undefined}
        onClose={onClose}
      />

      <DialogBody className={cn("max-h-[65vh] overflow-y-auto", pending && "pointer-events-none opacity-70")}>
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
                    <li key={id} className="inline-flex items-center gap-1 rounded-md bg-bg-hover py-0.5 pe-1 ps-1.5 text-sm">
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
      </DialogBody>

      {step !== "database" && (
        <DialogFooter>
          {(problem || error) && (
            <p role="alert" className="me-auto text-xs text-danger">
              {problem ?? error}
            </p>
          )}
          <Button variant="secondary" onClick={back}>
            {t("back")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={next}>
            {step === last ? (pending ? t("creating") : t("create")) : t("next")}
          </Button>
        </DialogFooter>
      )}
      {step === "database" && error && (
        <p role="alert" className="border-t border-border px-5 py-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The events an agent starts on by default: Slack's messages, GitHub's pull requests, anything signed as Leafdesk signs. */
const DEFAULT_EVENT: Record<EventPreset, string> = { slack: "message", github: "pull_request", hmac: "" };

/**
 * The wins logger's setup: the log it adds rows to (and which of its properties it fills), the
 * connection whose events it reads (of one type, or any), and its name. Creating it adds the agent,
 * shares the log with it to edit and adds the connection's trigger that runs it; each row it adds
 * waits for an owner's approval.
 */
function EventAgentWizard({ workspaceId, template, onClose, onCreated }: WizardProps) {
  const t = useTranslations("settings.agents.wizard");
  const te = useTranslations("settings.connections.events");
  const tc = useTranslations("common");
  const pages = useShareablePages(workspaceId);
  const [step, setStep] = useState<"database" | "connection">("database");
  const [database, setDatabase] = useState<PickablePage | null>(null);
  const [log, setLog] = useState<ReturnType<typeof logPropertiesOf> | null>(null);
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [eventType, setEventType] = useState("");
  const [name, setName] = useState(template.name);
  const [tried, setTried] = useState(false);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    void listConnectionsAction(workspaceId)
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          setLoadError(res.error);
          setConnections([]);
          return;
        }
        setConnections(res.data);
        const first = res.data[0];
        if (first) {
          setConnectionId(first.id);
          setEventType(DEFAULT_EVENT[first.eventPreset]);
        }
      })
      .catch(() => {
        if (!live) return;
        setLoadError(tc("genericError"));
        setConnections([]);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  const chooseDatabase = (page: PickablePage) => {
    setDatabase(page);
    setTried(false);
    run(
      () => builtinAgentPropertiesAction(workspaceId, page.id),
      (loaded) => {
        setLog(logPropertiesOf(loaded.map((p) => ({ name: p.name, type: p.type, options: p.options.map((o) => o.name) }))));
        setStep("connection");
      },
    );
  };

  const connection = connections?.find((c) => c.id === connectionId);
  const missing = (): "needConnection" | "needName" | null => (!connection ? "needConnection" : !name.trim() ? "needName" : null);
  const gap = tried ? missing() : null;

  const create = () => {
    setTried(true);
    if (missing() || !database || !connection) return;
    const setup: BuiltinAgentSetup = {
      key: "wins-logger",
      databaseId: database.id,
      name: name.trim(),
      connectionId: connection.id,
      eventType: eventType.trim() || null,
    };
    run(() => installBuiltinAgentAction(workspaceId, setup), (result) => onCreated(result.agent));
  };

  const databases = pages && pages.filter((p) => p.kind === "database");
  const databaseTitle = pageLabel(database?.title ?? "", tc("untitled"));

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <WizardHeader
        template={template}
        step={
          <>
            {t(`steps.${step}`)}
            {database && step !== "database" && ` · ${databaseTitle}`}
          </>
        }
        onBack={step !== "database" ? () => setStep("database") : undefined}
        onClose={onClose}
      />

      <DialogBody className={cn("max-h-[65vh] overflow-y-auto", pending && "pointer-events-none opacity-70")}>
        {step === "database" && (
          <>
            <p className="text-sm text-fg-muted">{t("chooseLog")}</p>
            <PagePicker
              autoFocus
              pages={databases}
              label={t("searchDatabases")}
              empty={t("noDatabases")}
              onPick={chooseDatabase}
            />
          </>
        )}

        {step === "connection" && log && (
          <p className="text-sm text-fg-muted">
            {log.fills.length ? t("logFills", { properties: log.fills.map((p) => p.name).join(", ") }) : t("logFillsNone")}
            {log.left.length > 0 && ` ${t("logLeft", { max: MAX_LOG_PROPERTIES, properties: log.left.join(", ") })}`}
          </p>
        )}

        {step === "connection" &&
          (!connections ? (
            <p className="text-sm text-fg-muted">{tc("loading")}</p>
          ) : loadError ? (
            <p role="alert" className="text-sm text-danger">
              {loadError}
            </p>
          ) : !connections.length ? (
            <p className="text-sm text-fg-muted">
              {t.rich("noConnections", {
                link: (chunks) => (
                  <Link href={`/w/${workspaceId}/settings?tab=connections`} className="text-fg underline underline-offset-2 hover:text-accent">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : (
            <>
              <Field label={t("connection")} help={t("connectionHelp")}>
                <select
                  value={connectionId}
                  aria-label={t("connection")}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    const picked = connections.find((c) => c.id === e.target.value);
                    if (picked) setEventType(DEFAULT_EVENT[picked.eventPreset]);
                  }}
                  className={selectClass}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={te("eventType")} help={t("eventTypeHelp")}>
                <Input value={eventType} maxLength={MAX_TRIGGER_EVENT} onChange={(e) => setEventType(e.target.value)} placeholder={te("eventTypePlaceholder")} />
              </Field>
              <div className="space-y-3 border-t border-border pt-4">
                <Field label={t("name")}>
                  <Input value={name} maxLength={MAX_AGENT_NAME} onChange={(e) => setName(e.target.value)} />
                </Field>
                <p className="text-xs text-fg-muted">
                  {t("summaryEvents", { database: databaseTitle, connection: connection?.name ?? "" })} {t("summaryApproval")}
                </p>
              </div>
            </>
          ))}
      </DialogBody>

      {step === "connection" && (
        <DialogFooter>
          {(gap || error) && (
            <p role="alert" className="me-auto text-xs text-danger">
              {gap ? t(`errors.${gap}`) : error}
            </p>
          )}
          <Button variant="secondary" onClick={() => setStep("database")}>
            {t("back")}
          </Button>
          <Button variant="primary" disabled={pending || !connection} onClick={create}>
            {pending ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      )}
      {step === "database" && error && (
        <p role="alert" className="border-t border-border px-5 py-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * The company researcher's setup: the database of companies, which of its properties it may fill
 * (all it can, unless the owner unticks some), and its name. Creating it adds the agent, with web
 * access, and the automation that runs it on every new row.
 */
function CompanyDetailsWizard({ workspaceId, template, onClose, onCreated }: WizardProps) {
  const t = useTranslations("settings.agents.wizard");
  const tc = useTranslations("common");
  const pages = useShareablePages(workspaceId);
  const [step, setStep] = useState<"database" | "properties">("database");
  const [database, setDatabase] = useState<PickablePage | null>(null);
  const [properties, setProperties] = useState<WizardProperty[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [name, setName] = useState(template.name);
  const [tried, setTried] = useState(false);
  const { pending, error, run } = useAction();

  const fillable = (p: WizardProperty) => isCompanyProperty({ type: p.type, options: p.options, ai: p.ai });

  const chooseDatabase = (page: PickablePage) => {
    setDatabase(page);
    setTried(false);
    run(
      () => builtinAgentPropertiesAction(workspaceId, page.id),
      (loaded) => {
        const listed = loaded.filter((p) => (COMPANY_PROPERTY_TYPES as readonly string[]).includes(p.type));
        setProperties(listed);
        // Everything it can fill, up to the most it takes: the owner unticks what it must leave alone.
        setChosen(listed.filter(fillable).slice(0, MAX_COMPANY_PROPERTIES).map((p) => p.id));
        setStep("properties");
      },
    );
  };

  const back = () => {
    setTried(false);
    setStep("database");
  };

  const missing = (): "needProperty" | "needName" | null => (!chosen.length ? "needProperty" : !name.trim() ? "needName" : null);
  const gap = tried ? missing() : null;

  const create = () => {
    setTried(true);
    if (missing() || !database || !properties) return;
    // In the database's order, which the instructions keep.
    const ordered = properties.filter((p) => chosen.includes(p.id)).map((p) => p.id);
    const setup: BuiltinAgentSetup = { key: "company-details", databaseId: database.id, name: name.trim(), properties: ordered };
    run(() => installBuiltinAgentAction(workspaceId, setup), (result) => onCreated(result.agent));
  };

  const databases = pages && pages.filter((p) => p.kind === "database");
  const databaseTitle = pageLabel(database?.title ?? "", tc("untitled"));
  const offered = (properties ?? []).filter((p) => !p.ai);
  const autofilled = (properties ?? []).filter((p) => p.ai);

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      <WizardHeader
        template={template}
        step={
          <>
            {t(`steps.${step}`)}
            {database && step !== "database" && ` · ${databaseTitle}`}
          </>
        }
        onBack={step !== "database" ? back : undefined}
        onClose={onClose}
      />

      <DialogBody className={cn("max-h-[65vh] overflow-y-auto", pending && "pointer-events-none opacity-70")}>
        {step === "database" && (
          <>
            <p className="text-sm text-fg-muted">{t("chooseCompanies")}</p>
            <PagePicker autoFocus pages={databases} label={t("searchDatabases")} empty={t("noDatabases")} onPick={chooseDatabase} />
          </>
        )}

        {step === "properties" && properties && (
          <>
            {offered.some(fillable) ? (
              <Field label={t("companyProperties")} help={t("companyPropertiesHelp", { max: MAX_COMPANY_PROPERTIES })}>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {offered.map((p) => {
                    const usable = fillable(p);
                    const on = chosen.includes(p.id);
                    const list = p.type === "select" || p.type === "multi_select";
                    return (
                      <PropertyChoice
                        key={p.id}
                        type={p.type}
                        name={p.name}
                        hint={p.description || (list ? (usable ? p.options.map((o) => o.name).join(", ") : t("noOptions")) : "")}
                        checked={on}
                        disabled={!usable || (!on && chosen.length >= MAX_COMPANY_PROPERTIES)}
                        onChange={(checked) => setChosen((c) => (checked ? [...c, p.id] : c.filter((id) => id !== p.id)))}
                      />
                    );
                  })}
                </ul>
              </Field>
            ) : (
              <p className="text-sm text-fg-muted">{t("noCompanyProperties")}</p>
            )}
            {autofilled.length > 0 && (
              <p className="text-xs text-fg-muted">{t("companyAutofilled", { properties: autofilled.map((p) => p.name).join(", ") })}</p>
            )}
            <div className="space-y-3 border-t border-border pt-4">
              <Field label={t("name")}>
                <Input value={name} maxLength={MAX_AGENT_NAME} onChange={(e) => setName(e.target.value)} />
              </Field>
              <p className="text-xs text-fg-muted">
                {t("summary", { database: databaseTitle })} {t("summaryWeb")}
              </p>
            </div>
          </>
        )}
      </DialogBody>

      {step === "properties" && (
        <DialogFooter>
          {(gap || error) && (
            <p role="alert" className="me-auto text-xs text-danger">
              {gap ? t(`errors.${gap}`) : error}
            </p>
          )}
          <Button variant="secondary" onClick={back}>
            {t("back")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={create}>
            {pending ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      )}
      {step === "database" && error && (
        <p role="alert" className="border-t border-border px-5 py-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * A wizard's top bar, like DialogHeader's but with the back button before the template's icon and
 * title, where DialogHeader has no place for a button.
 */
function WizardHeader({ template, step, onBack, onClose }: { template: WizardProps["template"]; step: ReactNode; onBack?: () => void; onClose: () => void }) {
  const t = useTranslations("settings.agents.wizard");
  const tc = useTranslations("common");
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
      {onBack && (
        <IconButton label={t("back")} onClick={onBack} className="-ms-1.5 h-7 w-7">
          <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
        </IconButton>
      )}
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle text-lg leading-none">
        {template.icon}
      </span>
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate">{t("title", { name: template.name })}</DialogTitle>
        <p className="mt-0.5 truncate text-sm text-fg-muted">{step}</p>
      </div>
      <IconButton label={tc("close")} onClick={onClose} className="-me-1.5 -mt-0.5 h-7 w-7 text-fg-faint">
        <X className="h-4 w-4" />
      </IconButton>
    </div>
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
  const typeLabel = usePropertyTypeLabel();
  const label = (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <PropertyTypeIcon type={type as "select"} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-xs text-fg-faint">{typeLabel(type as "select")}</span>
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
