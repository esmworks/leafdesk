"use client";

import { ArrowLeft, CalendarClock, Zap, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { createAgentFromDraftAction, draftAgentAction } from "@/app/actions/agents";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton, PageIcon, pageLabel, selectClass, textareaClass } from "@/components/ui";
import { MAX_AGENT_REQUEST, type AgentDraft, type AgentDraftAutomation, type AgentDraftPage, type AgentDraftSchedule } from "@/lib/agent-draft";
import { AGENT_ACCESS_LEVELS, type AgentAccessLevel, type AgentView } from "@/lib/agents";
import { browserTimeZone } from "@/lib/time-zone";
import { AgentForm, type AgentModelNames } from "./agent-dialog";
import { useRuleSummary } from "./rule-summary";

/**
 * Creating an agent by saying what it should do: the AI drafts it (server/agents/draft.ts), and the
 * draft opens the usual form, filled in, with the pages it would share and the schedules and
 * automations it would set up. Nothing is saved until the person creates it; what they remove from
 * the lists isn't set up.
 */
export function AgentDescribeDialog({
  workspaceId,
  isOwner,
  models = null,
  webSearch = false,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  /** Only owners set the token limit (see AgentForm). */
  isOwner: boolean;
  models?: AgentModelNames | null;
  webSearch?: boolean;
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
}) {
  const t = useTranslations("settings.agents.describe");
  const tc = useTranslations("common");
  const [request, setRequest] = useState("");
  // Each draft starts the form afresh.
  const [draft, setDraft] = useState<{ value: AgentDraft; version: number } | null>(null);
  const { pending, error, run } = useAction();
  const text = request.trim();

  const submit = () => {
    if (!text || pending) return;
    run(
      () => draftAgentAction(workspaceId, text),
      (value) => setDraft((d) => ({ value, version: (d?.version ?? 0) + 1 })),
    );
  };

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      {/* Not DialogHeader: the back button comes before the title, and the header has no place for a button there. */}
      <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
        {draft && (
          <IconButton label={t("back")} onClick={() => setDraft(null)} className="-ms-1.5 h-7 w-7">
            <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate">{t(draft ? "reviewTitle" : "title")}</DialogTitle>
          <p className="mt-0.5 text-sm text-fg-muted">{t(draft ? "reviewHint" : "hint")}</p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} className="-me-1.5 -mt-0.5 h-7 w-7 text-fg-faint">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {draft ? (
        <DraftReview
          key={draft.version}
          workspaceId={workspaceId}
          isOwner={isOwner}
          draft={draft.value}
          models={models}
          webSearch={webSearch}
          onDone={onClose}
          onCreated={onCreated}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className={cn(pending && "opacity-70")}>
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-fg-muted">{t("label")}</span>
                <textarea
                  autoFocus
                  rows={6}
                  value={request}
                  maxLength={MAX_AGENT_REQUEST}
                  placeholder={t("placeholder")}
                  readOnly={pending}
                  onChange={(e) => setRequest(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  className={textareaClass}
                />
              </label>
              <p className="text-xs text-fg-muted">{t("help")}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            {error && (
              <p role="alert" className="me-auto text-xs text-danger">
                {error}
              </p>
            )}
            <Button variant="secondary" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!text || pending}>
              {pending ? t("drafting") : t("draft")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** The agent's form filled in from the draft, with the shares and triggers creating it sets up. */
function DraftReview({
  workspaceId,
  isOwner,
  draft,
  models,
  webSearch,
  onDone,
  onCreated,
}: {
  workspaceId: string;
  isOwner: boolean;
  draft: AgentDraft;
  models: AgentModelNames | null;
  webSearch: boolean;
  onDone: () => void;
  onCreated: (agent: AgentView) => void;
}) {
  const [pages, setPages] = useState(draft.pages);
  const [schedules, setSchedules] = useState(draft.schedules);
  const [automations, setAutomations] = useState(draft.automations);
  return (
    <AgentForm
      workspaceId={workspaceId}
      isOwner={isOwner}
      models={models}
      webSearch={webSearch}
      draft={{
        initial: draft,
        extra: (
          <DraftSetup
            pages={pages}
            schedules={schedules}
            automations={automations}
            onPages={setPages}
            onSchedules={setSchedules}
            onAutomations={setAutomations}
          />
        ),
        create: (value) =>
          createAgentFromDraftAction(workspaceId, {
            ...value,
            pages: pages.map((p) => ({ pageId: p.pageId, level: p.level })),
            schedules: schedules.map((s) => ({ rule: s.rule, task: s.task, databaseId: s.databaseId })),
            automations: automations.map((a) => ({ databaseId: a.databaseId, trigger: a.trigger, task: a.task })),
            timeZone: browserTimeZone(),
          }),
      }}
      onDone={onDone}
      onCreated={onCreated}
    />
  );
}

function DraftSetup({
  pages,
  schedules,
  automations,
  onPages,
  onSchedules,
  onAutomations,
}: {
  pages: AgentDraftPage[];
  schedules: AgentDraftSchedule[];
  automations: AgentDraftAutomation[];
  onPages: (pages: AgentDraftPage[]) => void;
  onSchedules: (schedules: AgentDraftSchedule[]) => void;
  onAutomations: (automations: AgentDraftAutomation[]) => void;
}) {
  const t = useTranslations("settings.agents.describe");
  const ta = useTranslations("settings.agents.access");
  const tc = useTranslations("common");
  const summary = useRuleSummary();
  const zone = browserTimeZone();
  const trigger = (a: AgentDraftAutomation) => {
    const database = pageLabel(a.databaseTitle, tc("untitled"));
    if (a.trigger.type === "row_created") return t("triggers.rowCreated", { database });
    if (a.trigger.type === "property_changed") {
      return a.propertyName ? t("triggers.propertyChanged", { database, property: a.propertyName }) : t("triggers.rowChanged", { database });
    }
    const date = a.propertyName ?? t(a.trigger.date === "created_time" ? "triggers.created" : "triggers.edited");
    return t("triggers.datePassed", { database, date, days: a.trigger.days });
  };
  const without = <T,>(list: T[], item: T) => list.filter((x) => x !== item);

  return (
    <>
      <section className="space-y-2 border-t border-border pt-3">
        <div>
          <h3 className="text-sm">{t("pages")}</h3>
          <p className="text-xs text-fg-muted">{t("pagesHelp")}</p>
        </div>
        {pages.length ? (
          <ul aria-label={t("pages")} className="divide-y divide-border rounded-md border border-border">
            {pages.map((p) => {
              const title = pageLabel(p.title, tc("untitled"));
              return (
                <li key={p.pageId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  <select
                    value={p.level}
                    aria-label={ta("levelFor", { title })}
                    onChange={(e) => onPages(pages.map((x) => (x === p ? { ...x, level: e.target.value as AgentAccessLevel } : x)))}
                    className={selectClass}
                  >
                    {AGENT_ACCESS_LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {ta(`level.${l}`)}
                      </option>
                    ))}
                  </select>
                  <IconButton label={t("remove", { item: title })} onClick={() => onPages(without(pages, p))} className="hover:text-danger">
                    <X className="h-4 w-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">{t("noPages")}</p>
        )}
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <div>
          <h3 className="text-sm">{t("setUp")}</h3>
          <p className="text-xs text-fg-muted">{t(automations.length ? "setUpHelpShares" : "setUpHelp")}</p>
        </div>
        {schedules.length || automations.length ? (
          <ul aria-label={t("setUp")} className="divide-y divide-border rounded-md border border-border">
            {schedules.map((s, i) => {
              const when = summary({ ...s.rule, start: "" }, zone);
              return (
                <SetupItem
                  key={`s${i}`}
                  icon={<CalendarClock className="h-3.5 w-3.5" />}
                  title={s.databaseTitle !== null ? t("scheduleOn", { when, database: pageLabel(s.databaseTitle, tc("untitled")) }) : when}
                  task={s.task}
                  removeLabel={t("remove", { item: when })}
                  onRemove={() => onSchedules(without(schedules, s))}
                />
              );
            })}
            {automations.map((a, i) => (
              <SetupItem
                key={`a${i}`}
                icon={<Zap className="h-3.5 w-3.5" />}
                title={trigger(a)}
                task={a.task}
                removeLabel={t("remove", { item: trigger(a) })}
                onRemove={() => onAutomations(without(automations, a))}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">{t("noSetUp")}</p>
        )}
      </section>
    </>
  );
}

function SetupItem({ icon, title, task, removeLabel, onRemove }: { icon: ReactNode; title: string; task: string; removeLabel: string; onRemove: () => void }) {
  const t = useTranslations("settings.agents.describe");
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-sm">
      <span className="mt-0.5 text-fg-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div>{title}</div>
        <p className="text-xs break-words whitespace-pre-wrap text-fg-muted">
          <span className="font-medium">{t("task")}</span> {task}
        </p>
      </div>
      <IconButton label={removeLabel} onClick={onRemove} className="hover:text-danger">
        <X className="h-4 w-4" />
      </IconButton>
    </li>
  );
}
