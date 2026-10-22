"use client";

import { ArrowDown, ArrowUp, Check, Copy, Play, RefreshCw, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  createAutomationAction,
  discardAutomationDraftAction,
  publishAutomationAction,
  rotateAutomationSecretAction,
  testAutomationWebhooksAction,
  updateAutomationAction,
} from "@/app/actions/automations";
import { copyText } from "@/components/settings/copy-button";
import { Button, cn, IconButton, Input, Switch } from "@/components/ui";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import {
  hasRow,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_STEP_MESSAGE,
  MAX_WEBHOOK_URL,
  STEP_ID,
  WEBHOOK_SIGNATURE_HEADER,
  type AutomationActionType,
} from "@/lib/automations";
import { TEMPLATE_ROOTS } from "@/lib/automation-templates";
import { useSchemas } from "./automations-data";
import { TestRunPanel } from "./automations-runs";
import {
  draftProblem,
  emptyDraft,
  goesForEach,
  keepForEachValid,
  namesPeopleType,
  needsRowDraft,
  newAction,
  renameStep,
  targetDatabase,
  toDraft,
  toInput,
  webhookUrls,
  type AgentChoice,
  type Automation,
  type Draft,
  type DraftAction,
  type DraftActionOf,
  type DraftProblem,
  type DraftTrigger,
  type Person,
} from "./automations-shared";
import { FindRowsEditor, HttpRequestEditor, RowWriteEditor, WaitEditor } from "./automations-steps";
import { DatePassedPreview, TriggerEditor } from "./automations-trigger";
import { PeoplePicker, selectClass, ValuesEditor } from "./automations-values";
import { StartSequenceEditor } from "./automations-sequences";
import { TemplateField, useStepVariables, VariablesProvider } from "./automations-variables";
import { PropertyTypeIcon } from "./property-icons";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

export { selectClass };

/** Steps offered to add, grouped as the menu shows them. */
const STEP_GROUPS: { group: "rows" | "people" | "outside" | "flow"; types: AutomationActionType[] }[] = [
  { group: "rows", types: ["set_properties", "find_rows", "create_row", "upsert_row", "move_to_trash"] },
  { group: "people", types: ["notify", "run_agent", "start_sequence"] },
  { group: "outside", types: ["http_request", "webhook"] },
  { group: "flow", types: ["wait", "log"] },
];

/** Steps that only act on the run's row and can't go "for each": not for a trigger without one. */
const ROW_ONLY_TYPES: AutomationActionType[] = ["move_to_trash", "webhook"];

/**
 * The new-automation and edit form. A new automation is published at once or saved as a draft;
 * changes to a saved one are kept as a draft, which test runs run, until they are published.
 */
export function AutomationEditor({
  workspaceId,
  databaseId,
  saved,
  example,
  people,
  agents,
  isOwner,
  onSaved,
  onUpdated,
  onTestDone,
  onCancel,
}: {
  workspaceId: string;
  databaseId: string;
  /** The automation being edited; null for a new one. */
  saved: Automation | null;
  /** A new one's steps to start from (an example), instead of an empty form. */
  example?: Draft;
  people: Person[];
  /** The agents a "Run an agent" action can pick; owners, and those who can edit an agent (`canRun`), make one. */
  agents: AgentChoice[];
  isOwner: boolean;
  /** After a save: the automation as stored, whether it was just created, and whether to stay in the form. */
  onSaved: (automation: Automation, created: boolean, stay: boolean) => void;
  /** The automation changed and the form stays (a draft saved, a secret or address replaced). */
  onUpdated: (automation: Automation) => void;
  /** A test run ended (or a minute went by): show it in the history. */
  onTestDone: (automationId: string, runId: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const format = useFormatter();
  const properties = useSchema();
  const [base, setBase] = useState<Draft>(() => (saved ? toDraft(saved, properties) : (example ?? emptyDraft())));
  const [draft, setDraft] = useState<Draft>(base);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | "discard" | null>(null);
  const [testing, setTesting] = useState(false);

  const loaded = useSchemas(draft.actions.map((a) => targetDatabase(draft.actions, a, databaseId)).filter((id) => id !== databaseId));
  const schemaOf = useCallback((id: string) => (id === databaseId ? properties : loaded(id)), [databaseId, properties, loaded]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const stepsDirty = JSON.stringify([draft.trigger, draft.actions]) !== JSON.stringify([base.trigger, base.actions]);
  const unpublished = !!saved && (saved.version < 1 || saved.draft !== null);

  const setTrigger = (trigger: DraftTrigger) => setDraft((d) => ({ ...d, trigger }));
  const setActions = (update: (actions: DraftAction[]) => DraftAction[]) => setDraft((d) => ({ ...d, actions: keepForEachValid(update(d.actions)) }));
  const setAction = (key: string, next: DraftAction) => setActions((actions) => actions.map((a) => (a.key === key ? next : a)));
  const addAction = (type: AutomationActionType) =>
    setActions((actions) => {
      const action = newAction(type, actions, draft.trigger, databaseId);
      // Moving to the trash stays last: what is added goes before it.
      const trash = actions.findIndex((a) => a.type === "move_to_trash");
      return trash === -1 ? [...actions, action] : [...actions.slice(0, trash), action, ...actions.slice(trash)];
    });
  const move = (key: string, by: -1 | 1) =>
    setActions((actions) => {
      const at = actions.findIndex((a) => a.key === key);
      const to = at + by;
      if (at < 0 || to < 0 || to >= actions.length) return actions;
      const next = [...actions];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });

  const problemText = (p: DraftProblem) => {
    const text = t(`form.errors.${p.problem}` as "form.errors.needName");
    return p.step ? t("form.errors.inStep", { step: p.step, problem: text }) : text;
  };

  /**
   * Saves the form: a draft (`publish` false) or the next version. A saved automation's name and
   * whether it is on change either way; only a changed trigger or steps make a draft. Returns
   * the automation as stored, or null when it couldn't be saved.
   */
  const save = async (publish: boolean): Promise<Automation | null> => {
    const problem = draftProblem(draft, properties, schemaOf, databaseId);
    if (problem) {
      setError(problemText(problem));
      return null;
    }
    setBusy(publish ? "publish" : "save");
    setError(null);
    try {
      const input = toInput(draft, properties, schemaOf, databaseId);
      let res;
      if (!saved) res = await createAutomationAction(databaseId, input, { publish });
      else if (stepsDirty) res = await updateAutomationAction(saved.id, input, { publish });
      else {
        res = dirty ? await updateAutomationAction(saved.id, { name: input.name, enabled: input.enabled }) : { ok: true as const, data: saved };
        // The steps as saved: published as they are when asked to.
        if (res.ok && publish && (res.data.draft || res.data.version < 1)) res = await publishAutomationAction(saved.id);
      }
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      setBase(draft);
      if (!saved) {
        // A new draft stays open to test it; a new webhook's secret and address show once saved.
        onSaved(res.data, true, !publish || !!res.data.secret || !!res.data.hookUrl);
      } else if (publish) onSaved(res.data, false, false);
      else onUpdated(res.data);
      return res.data;
    } catch {
      setError(tc("genericError"));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!saved || !confirm(t("lifecycle.confirmDiscard"))) return;
    setBusy("discard");
    setError(null);
    try {
      const res = await discardAutomationDraftAction(saved.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const next = toDraft(res.data, properties);
      setBase(next);
      setDraft(next);
      onUpdated(res.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(null);
    }
  };

  const full = draft.actions.length >= MAX_AUTOMATION_ACTIONS;
  const hasTrash = draft.actions.some((a) => a.type === "move_to_trash");
  const hasAgent = draft.actions.some((a) => a.type === "run_agent");
  const hasFind = draft.actions.some((a) => a.type === "find_rows");
  const rowRun = hasRow(draft.trigger);
  const canRunAgents = isOwner || agents.some((a) => a.canRun);
  const offered = (type: AutomationActionType) => {
    if (type === "run_agent" && !canRunAgents) return false;
    return true;
  };
  const disabledType = (type: AutomationActionType) =>
    (type === "move_to_trash" && (hasTrash || hasAgent)) ||
    (type === "run_agent" && hasTrash) ||
    (!rowRun && ROW_ONLY_TYPES.includes(type)) ||
    (!rowRun && goesForEach(type) && type !== "notify" && !hasFind);

  return (
    <>
      <div className={cn("max-h-[65vh] overflow-y-auto px-5 py-4", busy && "pointer-events-none opacity-70")}>
        {saved && (
          <StatusBar
            saved={saved}
            busy={busy !== null}
            testing={testing}
            onTest={() => setTesting(true)}
            onDiscard={() => void discard()}
            savedAt={saved.draft ? format.relativeTime(new Date(saved.draft.savedAt)) : null}
          />
        )}
        {saved && testing && (
          <TestRunPanel
            automationId={saved.id}
            databaseId={databaseId}
            trigger={draft.trigger}
            // Unsaved changes are saved as the draft first: the test runs what the form shows.
            prepare={async () => (dirty ? ((await save(false))?.id ?? null) : saved.id)}
            onDone={onTestDone}
            onCancel={() => setTesting(false)}
          />
        )}

        <Field label={t("form.name")} className="mt-4 first:mt-0">
          <Input
            value={draft.name}
            maxLength={MAX_AUTOMATION_NAME}
            autoFocus={!saved}
            placeholder={t("form.namePlaceholder")}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>

        <Section title={t("form.when")}>
          <TriggerEditor trigger={draft.trigger} people={people} saved={saved} onChange={setTrigger} onUpdated={onUpdated} />
          {draft.trigger.type === "date_passed" && (
            <DatePassedPreview databaseId={databaseId} automationId={saved?.id ?? null} trigger={draft.trigger} />
          )}
        </Section>

        <Section title={t("form.then")}>
          <ol className="space-y-2">
            {draft.actions.map((action, index) => (
              <StepCard
                key={action.key}
                workspaceId={workspaceId}
                databaseId={databaseId}
                draft={draft}
                index={index}
                schemaOf={schemaOf}
                people={people}
                agents={agents}
                isOwner={isOwner}
                onChange={(next) => setAction(action.key, next)}
                onRename={(to) => setActions((actions) => renameStep(actions, action.id, to))}
                onMove={(by) => move(action.key, by)}
                onRemove={() => setActions((actions) => actions.filter((a) => a.key !== action.key))}
              />
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
              {STEP_GROUPS.map(({ group, types }) => (
                <optgroup key={group} label={t(`form.stepGroup.${group}`)}>
                  {types.filter(offered).map((type) => (
                    <option key={type} value={type} disabled={disabledType(type)}>
                      {t(`form.actionType.${type}`)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {!rowRun && !hasFind && <p className="mt-1 text-xs text-fg-faint">{t("form.noRowHelp")}</p>}
          </div>
        </Section>

        {draft.actions.some((a) => a.type === "webhook") && (
          <Section title={t("webhook.title")}>
            {saved?.secret ? (
              <WebhookTools
                automation={saved}
                changed={webhookUrls(saved.draft?.actions ?? saved.actions) !== webhookUrls(draft.actions)}
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
        <Button disabled={busy !== null || (!!saved && !dirty)} onClick={() => void save(false)}>
          {busy === "save" ? tc("saving") : saved ? t("lifecycle.saveDraft") : t("lifecycle.saveAsDraft")}
        </Button>
        <Button variant="primary" disabled={busy !== null || (!!saved && !dirty && !unpublished)} onClick={() => void save(true)}>
          {busy === "publish" ? t("lifecycle.publishing") : t("lifecycle.publish")}
        </Button>
      </Footer>
    </>
  );
}

/** Where a saved automation stands: published, a draft never published, or changes not yet published. */
function StatusBar({
  saved,
  busy,
  testing,
  savedAt,
  onTest,
  onDiscard,
}: {
  saved: Automation;
  busy: boolean;
  testing: boolean;
  savedAt: string | null;
  onTest: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations("database.automations.lifecycle");
  const state = saved.version < 1 ? "neverPublished" : saved.draft ? "unpublished" : "published";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2",
        state === "published" ? "border-border" : "border-accent/40 bg-accent/5",
      )}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {state === "neverPublished" ? t("neverPublished") : state === "unpublished" ? t("unpublished") : t("published", { version: saved.version })}
        </p>
        <p className="text-xs text-fg-muted">
          {state === "neverPublished"
            ? t("neverPublishedHelp")
            : state === "unpublished"
              ? t("unpublishedHelp", { version: saved.version, time: savedAt ?? "" })
              : t("publishedHelp")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {state === "unpublished" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
            {t("discard")}
          </Button>
        )}
        <Button size="sm" disabled={busy || testing} onClick={onTest}>
          <Play className="h-3.5 w-3.5" />
          {t("test")}
        </Button>
      </div>
    </div>
  );
}

export function Footer({ error, children }: { error?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
      {error && (
        <p role="alert" className="me-auto text-xs text-danger">
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

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * One step: its id (what later steps call it by), type and, for steps that can, the rows it goes
 * over; then its own editor, with the variables it can use.
 */
function StepCard({
  workspaceId,
  databaseId,
  draft,
  index,
  schemaOf,
  people,
  agents,
  isOwner,
  onChange,
  onRename,
  onMove,
  onRemove,
}: {
  workspaceId: string;
  databaseId: string;
  draft: Draft;
  index: number;
  schemaOf: (databaseId: string) => Property[] | undefined;
  people: Person[];
  agents: AgentChoice[];
  isOwner: boolean;
  onChange: (action: DraftAction) => void;
  onRename: (id: string) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const action = draft.actions[index];
  const variables = useStepVariables(draft, index, properties, schemaOf, databaseId);
  const finds = draft.actions.slice(0, index).filter((a) => a.type === "find_rows");
  const rowRun = hasRow(draft.trigger);
  const target = targetDatabase(draft.actions, action, databaseId);
  const targetProps = schemaOf(target);
  // "Whoever made the change" is only someone for a row added or changed.
  const noActor = draft.trigger.type !== "row_created" && draft.trigger.type !== "property_changed";
  const missingRow = !rowRun && needsRowDraft(action);

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StepIdInput id={action.id} taken={draft.actions.filter((a) => a.key !== action.key).map((a) => a.id)} onCommit={onRename} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(`form.actionType.${action.type}`)}</span>
        <IconButton label={t("form.moveUp")} disabled={index === 0} onClick={() => onMove(-1)} className="disabled:opacity-40">
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t("form.moveDown")} disabled={index === draft.actions.length - 1} onClick={() => onMove(1)} className="disabled:opacity-40">
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t("form.removeAction")} onClick={onRemove} className="hover:text-danger">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {"forEach" in action && (finds.length > 0 || action.forEach) && (
        <label className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="shrink-0 text-xs text-fg-muted">{t("form.runsOn")}</span>
          <select
            value={action.forEach}
            onChange={(e) => onChange({ ...action, forEach: e.target.value } as DraftAction)}
            className={cn(selectClass, "sm:w-auto sm:min-w-56")}
          >
            <option value="">{rowRun ? t("form.theRow") : t("form.chooseRows")}</option>
            {finds.map((f) => (
              <option key={f.key} value={f.id}>
                {t("form.eachFound", { id: f.id })}
              </option>
            ))}
          </select>
        </label>
      )}
      {missingRow && (
        <p className="mb-2 text-xs text-danger">
          {t(goesForEach(action.type) ? "form.needsForEach" : "form.needsRow")}
        </p>
      )}
      <VariablesProvider value={variables}>
        <StepBody
          workspaceId={workspaceId}
          databaseId={databaseId}
          action={action}
          target={target}
          targetProps={targetProps}
          people={people}
          agents={agents}
          isOwner={isOwner}
          noActor={noActor}
          rowRun={rowRun}
          onChange={onChange}
        />
      </VariablesProvider>
    </li>
  );
}

function StepBody({
  workspaceId,
  databaseId,
  action,
  target,
  targetProps,
  people,
  agents,
  isOwner,
  noActor,
  rowRun,
  onChange,
}: {
  workspaceId: string;
  databaseId: string;
  action: DraftAction;
  /** The database whose rows the step acts on. */
  target: string;
  /** The properties of the database the step writes to; undefined while they load. */
  targetProps: Property[] | undefined;
  people: Person[];
  agents: AgentChoice[];
  isOwner: boolean;
  noActor: boolean;
  rowRun: boolean;
  onChange: (action: DraftAction) => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  switch (action.type) {
    case "set_properties":
      return targetProps ? (
        <ValuesEditor entries={action.entries} properties={targetProps} people={people} noActor={noActor} onChange={(entries) => onChange({ ...action, entries })} />
      ) : (
        <p className="text-xs text-fg-muted">{tc("loading")}</p>
      );
    case "notify":
      return (
        <NotifyEditor
          action={action}
          people={people}
          personProperties={rowRun || action.forEach ? (targetProps ?? []).filter((p) => namesPeopleType(p.type)) : []}
          onChange={onChange}
        />
      );
    case "move_to_trash":
      return <p className="text-xs text-fg-muted">{t("form.trashHelp")}</p>;
    case "webhook":
      return (
        <Input
          type="url"
          inputMode="url"
          dir="ltr"
          value={action.url}
          maxLength={MAX_WEBHOOK_URL}
          aria-label={t("form.webhookUrl")}
          placeholder={t("form.webhookPlaceholder")}
          onChange={(e) => onChange({ ...action, url: e.target.value })}
        />
      );
    case "run_agent":
      return <RunAgentEditor workspaceId={workspaceId} action={action} agents={agents} isOwner={isOwner} onChange={onChange} />;
    case "start_sequence":
      return <StartSequenceEditor action={action} sameDatabase={target === databaseId} onChange={onChange} />;
    case "http_request":
      return <HttpRequestEditor action={action} onChange={onChange} />;
    case "find_rows":
      return <FindRowsEditor databaseId={databaseId} action={action} onChange={onChange} />;
    case "create_row":
    case "upsert_row":
      return <RowWriteEditor databaseId={databaseId} action={action} people={people} noActor={noActor} onChange={onChange} />;
    case "wait":
      return <WaitEditor action={action} onChange={onChange} />;
    case "log":
      return (
        <div className="space-y-1">
          <TemplateField
            rows={2}
            value={action.message}
            maxLength={MAX_STEP_MESSAGE}
            aria-label={t("steps.logMessage")}
            placeholder={t("steps.logPlaceholder", { template: "{{trigger.title}}" })}
            onChange={(message) => onChange({ ...action, message })}
          />
          <p className="text-xs text-fg-faint">{t("steps.logHelp")}</p>
        </div>
      );
  }
}

/**
 * A step's id as typed: lowercase letters, digits and _, starting with a letter. Taken on leaving
 * the field, when it is one and no other step has it; later steps' templates follow the rename.
 */
function StepIdInput({ id, taken, onCommit }: { id: string; taken: string[]; onCommit: (id: string) => void }) {
  const t = useTranslations("database.automations.form");
  const [text, setText] = useState(id);
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : id;
  const valid = STEP_ID.test(shown) && !(TEMPLATE_ROOTS as readonly string[]).includes(shown) && !taken.includes(shown);
  const commit = () => {
    setEditing(false);
    if (text !== id && STEP_ID.test(text) && !(TEMPLATE_ROOTS as readonly string[]).includes(text) && !taken.includes(text)) onCommit(text);
  };
  return (
    <input
      value={shown}
      maxLength={32}
      spellCheck={false}
      dir="ltr"
      aria-label={t("stepId")}
      aria-invalid={!valid}
      title={valid ? t("stepIdHelp") : t("stepIdInvalid")}
      onFocus={() => {
        setText(id);
        setEditing(true);
      }}
      onChange={(e) => setText(e.target.value.toLowerCase().replace(/[\s-]+/g, "_"))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.stopPropagation();
          setText(id);
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "h-6 w-28 rounded-md border bg-bg-hover px-1.5 text-xs outline-none focus:border-accent",
        valid ? "border-transparent" : "border-danger",
      )}
    />
  );
}

/**
 * The agent to run and the task it gets for this automation, or, with no agent yet, where owners
 * make one. Saving shares the database with the agent (edit), so it can change the row. Only
 * owners change it: others see it as it is (and may remove it).
 */
function RunAgentEditor({
  workspaceId,
  action,
  agents,
  isOwner,
  onChange,
}: {
  workspaceId: string;
  action: DraftActionOf<"run_agent">;
  agents: AgentChoice[];
  isOwner: boolean;
  onChange: (action: DraftActionOf<"run_agent">) => void;
}) {
  const t = useTranslations("database.automations.form");
  const chosen = agents.find((a) => a.id === action.agentId);
  // Owners give any agent a task; others only one they can edit, and change only such an action.
  const editable = isOwner || (action.agentId ? Boolean(chosen?.canRun) : true);
  const choices = isOwner ? agents : agents.filter((a) => a.canRun || a.id === action.agentId);
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
        disabled={!editable}
        onChange={(e) => onChange({ ...action, agentId: e.target.value })}
        className={selectClass}
      >
        <option value="">{t("chooseAgent")}</option>
        {choices.map((a) => (
          <option key={a.id} value={a.id}>
            {a.icon ? `${a.icon} ` : ""}
            {a.enabled ? a.name : t("pausedAgent", { name: a.name })}
          </option>
        ))}
        {action.agentId && !chosen && <option value={action.agentId}>{t("archivedAgent")}</option>}
      </select>
      {chosen?.description && <p className="text-xs text-fg-muted">{chosen.description}</p>}
      <div>
        <span className="mb-1 flex items-baseline justify-between gap-2 text-xs text-fg-muted">
          {t("agentTask")}
          <span className="tabular-nums text-fg-faint">
            {action.prompt.length} / {MAX_AGENT_PROMPT}
          </span>
        </span>
        <TemplateField
          rows={3}
          value={action.prompt}
          maxLength={MAX_AGENT_PROMPT}
          aria-label={t("agentTask")}
          placeholder={t("agentTaskPlaceholder")}
          readOnly={!editable}
          onChange={(prompt) => onChange({ ...action, prompt })}
        />
      </div>
      <p className="text-xs text-fg-faint">
        {!editable ? t("agentOwnersOnly") : chosen ? t("agentAccess", { agent: chosen.name }) : t("agentAccessAny")}
      </p>
    </div>
  );
}

/** Who a notification goes to (chosen people and the people a row's person properties name), and what it says. */
function NotifyEditor({
  action,
  people,
  personProperties,
  onChange,
}: {
  action: DraftActionOf<"notify">;
  people: Person[];
  /** The person properties of the row it is about; none without a row. */
  personProperties: Property[];
  onChange: (action: DraftActionOf<"notify">) => void;
}) {
  const t = useTranslations("database.automations");
  const listed = useMemo(() => new Set(personProperties.map((p) => p.id)), [personProperties]);
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs text-fg-muted">{t("form.people")}</p>
        <PeoplePicker people={people} selected={action.people} onChange={(ids) => onChange({ ...action, people: ids })} />
      </div>
      {(personProperties.length > 0 || action.properties.some((id) => !listed.has(id))) && (
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
            {action.properties
              .filter((id) => !listed.has(id))
              .map((id) => (
                <li key={id} className="flex items-center gap-2 px-1 py-1 text-sm text-fg-muted">
                  <span className="truncate">{t("deletedProperty")}</span>
                  <button
                    type="button"
                    onClick={() => onChange({ ...action, properties: action.properties.filter((x) => x !== id) })}
                    className="text-xs underline underline-offset-2 hover:text-fg"
                  >
                    {t("form.removeProperty")}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      <div>
        <p className="mb-1 text-xs text-fg-muted">{t("form.message")}</p>
        <TemplateField
          rows={2}
          value={action.message}
          maxLength={MAX_STEP_MESSAGE}
          aria-label={t("form.message")}
          placeholder={t("form.messagePlaceholder")}
          onChange={(message) => onChange({ ...action, message })}
        />
      </div>
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
