"use client";

import { Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { setAgentMailboxAction, setAgentMailTriggerAction } from "@/app/actions/agents";
import { read } from "@/components/read";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Input, Switch, textareaClass } from "@/components/ui";
import { MAX_MAIL_RUNS_PER_DAY, MAX_MAIL_RUNS_PER_HOUR, MAX_MAIL_SUBJECT, MAX_MAIL_TASK, type AgentView } from "@/lib/agents";
import { parseMailSenders } from "@/lib/agent-mail-trigger";
import type { AgentMailboxView } from "@/server/agents/mail";

/**
 * The person's own mailboxes on an agent's Access tab, each opened to the agent or not
 * (server/agents/mail.ts), and for one that is open, whether its new email starts the agent's runs
 * (agents/mail-trigger.ts). Shown to whoever may use the agent and the Mail tab; no one else's.
 */
export function AgentMailboxes({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.mail");
  const [boxes, setBoxes] = useState<AgentMailboxView[] | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    read("agentMailboxes", workspaceId, agent.id)
      .then((res) => live && res.ok && setBoxes(res.data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id]);

  if (!boxes?.length) return null;
  return (
    <section aria-labelledby="agent-mail-title" className={cn("space-y-2 border-t border-border pt-4", pending && "opacity-70")}>
      <h3 id="agent-mail-title" className="text-sm font-medium">
        {t("title")}
      </h3>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {boxes.map((box) => (
          <li key={box.id} className="space-y-2 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{box.address}</span>
              <Switch
                checked={box.open}
                label={t("open", { address: box.address })}
                disabled={pending || (agent.archived && !box.open)}
                onChange={(open) => run(() => setAgentMailboxAction(workspaceId, agent.id, box.id, open), setBoxes)}
              />
            </div>
            {box.open && <MailTrigger workspaceId={workspaceId} agent={agent} box={box} onSaved={setBoxes} />}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">{t("note")}</p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Whether new email in the mailbox starts the agent: turned off at once, turned on (or changed)
 * with the form, since it needs a task.
 */
function MailTrigger({ workspaceId, agent, box, onSaved }: { workspaceId: string; agent: AgentView; box: AgentMailboxView; onSaved: (boxes: AgentMailboxView[]) => void }) {
  const t = useTranslations("settings.agents.mail.trigger");
  const tc = useTranslations("common");
  const id = useId();
  const saved = box.trigger;
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState(saved.task);
  const [senders, setSenders] = useState(saved.filters.senders.join(", "));
  const [subject, setSubject] = useState(saved.filters.subject);
  const [knownOnly, setKnownOnly] = useState(saved.filters.knownOnly);
  const { pending, error, run } = useAction();
  const parsedSenders = parseMailSenders(senders);
  const valid = task.trim().length > 0 && parsedSenders !== null;

  const reset = () => {
    setTask(saved.task);
    setSenders(saved.filters.senders.join(", "));
    setSubject(saved.filters.subject);
    setKnownOnly(saved.filters.knownOnly);
  };
  const save = (on: boolean) =>
    run(
      () => setAgentMailTriggerAction(workspaceId, agent.id, box.id, { on, task, filters: { senders: parsedSenders ?? [], subject, knownOnly } }),
      (boxes) => {
        setEditing(false);
        onSaved(boxes);
      },
    );

  return (
    <div className={cn("ms-6 space-y-2", pending && "opacity-70")} data-mail-trigger={box.id}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block">{t("label")}</span>
          {saved.on && !editing && (
            <span className="block truncate text-xs text-fg-muted" title={saved.task}>
              {saved.task}
            </span>
          )}
        </span>
        {saved.on && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
            {t("edit")}
          </Button>
        )}
        <Switch
          checked={saved.on || editing}
          label={t("label")}
          disabled={pending || agent.archived}
          onChange={(on) => {
            if (on) setEditing(true);
            else if (saved.on) save(false);
            else {
              reset();
              setEditing(false);
            }
          }}
        />
      </div>
      {saved.on && saved.limitedAt && !editing && <p className="text-xs text-fg-muted">{t("limited")}</p>}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save(true);
          }}
        >
          <label htmlFor={`${id}-task`} className="block text-xs font-medium text-fg-muted">
            {t("task")}
          </label>
          <textarea
            id={`${id}-task`}
            className={textareaClass}
            rows={3}
            maxLength={MAX_MAIL_TASK}
            value={task}
            placeholder={t("taskPlaceholder")}
            onChange={(e) => setTask(e.target.value)}
          />
          <label htmlFor={`${id}-senders`} className="block text-xs font-medium text-fg-muted">
            {t("senders")}
          </label>
          <Input id={`${id}-senders`} value={senders} placeholder={t("sendersPlaceholder")} onChange={(e) => setSenders(e.target.value)} aria-invalid={parsedSenders === null} />
          {parsedSenders === null && <p className="text-xs text-danger">{t("sendersInvalid")}</p>}
          <label htmlFor={`${id}-subject`} className="block text-xs font-medium text-fg-muted">
            {t("subject")}
          </label>
          <Input id={`${id}-subject`} value={subject} maxLength={MAX_MAIL_SUBJECT} placeholder={t("subjectPlaceholder")} onChange={(e) => setSubject(e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={knownOnly} onChange={(e) => setKnownOnly(e.target.checked)} className="accent-accent" />
            {t("knownOnly")}
          </label>
          <p className="text-xs text-fg-muted">{t("skipped", { hour: MAX_MAIL_RUNS_PER_HOUR, day: MAX_MAIL_RUNS_PER_DAY })}</p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => {
                reset();
                setEditing(false);
              }}
            >
              {tc("cancel")}
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={pending || !valid}>
              {tc("save")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
