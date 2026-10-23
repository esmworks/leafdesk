"use client";

import { AlertTriangle, ArrowRight, Check, Pencil, Repeat, X, Zap } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { approvePendingChangeAction, dismissPendingChangeAction, editPendingChangeAction } from "@/app/actions/review";
import { Value } from "@/components/database/row-activity";
import { Button, cn, Input, pageLabel, textareaClass } from "@/components/ui";
import { agentRunPath } from "@/lib/agents";
import type { PendingChangeView, PendingFieldView } from "@/lib/pending-changes";
import { relativeTime } from "@/lib/relative-time";

/** Values a reviewer can change in place; the others are kept or left out. */
const EDITABLE_TYPES = new Set(["text", "url", "email", "phone", "number"]);
const editable = (f: PendingFieldView) =>
  f.property === null || EDITABLE_TYPES.has(f.property.type) || f.property.type === "checkbox" || (f.property.type === "date" && typeof f.raw === "string");
const fieldKey = (f: PendingFieldView) => f.property?.id ?? "title";

/** The time relative dates count from: the server's render time until the page is up, so both render alike. */
const NowContext = createContext<Date | null>(null);

/** Gives the changes below a clock that starts at `initial` (the server's render time) and then follows the real one. */
export function NowProvider({ initial, children }: { initial: string; children: ReactNode }) {
  const [now, setNow] = useState(() => new Date(initial));
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

/** The agent's emoji, or its initial, in a round badge; a follow-up's (`sequence`) its sign. */
export function AgentBadge({ agent, size = "md", sequence = false }: { agent: PendingChangeView["agent"]; size?: "sm" | "md"; sequence?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted",
        size === "sm" ? "h-5 w-5 text-xs" : "h-7 w-7 text-sm",
      )}
    >
      {sequence ? <Repeat className="h-3.5 w-3.5" /> : (agent?.icon ?? (agent?.name.slice(0, 1).toUpperCase() || "?"))}
    </span>
  );
}

/** What proposed a change in a round badge: the agent's emoji or initial, or an automation's mark. */
export function ChangeBadge({ change, size = "md" }: { change: PendingChangeView; size?: "sm" | "md" }) {
  if (change.kind !== "automation_approval") return <AgentBadge agent={change.agent} size={size} sequence={!!change.sequence} />;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted", size === "sm" ? "h-5 w-5" : "h-7 w-7")}>
      <Zap className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </span>
  );
}

/** "Agent wants to change Row": who proposed what, with links to the row and database. */
export function ChangeHeadline({ change, workspaceId, showDatabase = true }: { change: PendingChangeView; workspaceId: string; showDatabase?: boolean }) {
  const t = useTranslations("review");
  const tc = useTranslations("common");
  const strong = "font-medium text-fg";
  const link = "font-medium text-fg hover:underline";
  const tags = {
    agent: () => <bdi className={strong}>{change.agent?.name ?? t("unknownAgent")}</bdi>,
    automation: () => <bdi className={strong}>{change.approval?.automation?.name ?? t("unknownAutomation")}</bdi>,
    row: () =>
      change.row ? (
        <Link href={`/w/${workspaceId}/p/${change.row.id}`} className={link}>
          {change.row.icon ? `${change.row.icon} ` : ""}
          {pageLabel(change.row.title, tc("untitled"))}
        </Link>
      ) : (
        <span className={strong}>{tc("untitled")}</span>
      ),
    database: () => (
      <Link href={`/w/${workspaceId}/p/${change.database.id}`} className={link}>
        {change.database.icon ? `${change.database.icon} ` : ""}
        {pageLabel(change.database.title, tc("untitled"))}
      </Link>
    ),
  };
  // An approved new row has its row: it reads as the row it became.
  const key =
    change.kind === "create_row"
      ? "createRow"
      : change.kind === "email_draft"
        ? "emailDraft"
        : change.kind === "automation_approval"
          ? change.row
            ? "automationApproval"
            : "automationApprovalNoRow"
          : "updateRow";
  // A follow-up's email: which one of the sequence it is.
  const sequence = change.sequence;
  return (
    <span>
      {sequence
        ? t.rich("proposes.sequenceDraft", {
            ...tags,
            sequence: () => <bdi className={strong}>{sequence.name}</bdi>,
            step: sequence.step,
            steps: sequence.steps,
          })
        : t.rich(`proposes.${key}`, tags)}
      {showDatabase && change.kind !== "create_row" && <span className="text-fg-muted"> · {t.rich("inDatabase", tags)}</span>}
    </span>
  );
}

/** When it was proposed, the run that did, whether someone edited it, and when it expires or how it was answered. */
export function ChangeMeta({ change, workspaceId }: { change: PendingChangeView; workspaceId: string }) {
  const t = useTranslations("review");
  const locale = useLocale();
  const now = useContext(NowContext) ?? new Date();
  const ago = (date: string) => relativeTime(date, locale, now);
  const parts: ReactNode[] = [<time key="at" dateTime={change.createdAt}>{ago(change.createdAt)}</time>];
  if (change.agent && change.runId) {
    parts.push(
      <Link key="run" href={agentRunPath(workspaceId, change.agent.id, change.runId)} className="hover:text-fg hover:underline">
        {t("viewRun")}
      </Link>,
    );
  }
  if (change.approval?.runPath) {
    parts.push(
      <Link key="run" href={change.approval.runPath} className="hover:text-fg hover:underline">
        {t("viewRun")}
      </Link>,
    );
  }
  if (change.edited) parts.push(<span key="edited">{t("edited")}</span>);
  if (change.status === "pending") parts.push(<span key="exp">{t("expires", { time: ago(change.expiresAt) })}</span>);
  if (change.status === "approved" || change.status === "dismissed") {
    // A dismissed approval stopped its run: it reads as rejected.
    const how = change.kind === "automation_approval" && change.status === "dismissed" ? "rejected" : change.status;
    parts.push(
      <span key="decided">
        {t(`decided.${how}`, { name: change.decidedBy?.name ?? t("someone"), time: ago(change.decidedAt ?? change.createdAt) })}
      </span>,
    );
  }
  if (change.status === "expired") parts.push(<span key="expired">{t(change.kind === "automation_approval" ? "decided.timedOut" : "decided.expired")}</span>);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </span>
  );
}

/** Values that read as text get the diff's colours; chips and names keep their own, the old one struck through. */
const plain = (v: PendingFieldView["after"]) => v.type === "text" || v.type === "number" || v.type === "date" || v.type === "checkbox";

function Before({ value }: { value: PendingFieldView["after"] }) {
  return plain(value) ? (
    <span className="rounded-sm bg-removed-bg px-1 text-removed-fg line-through decoration-removed-bar [&_*]:text-removed-fg">
      <Value value={value} />
    </span>
  ) : (
    <span className="line-through opacity-60">
      <Value value={value} />
    </span>
  );
}

function After({ value }: { value: PendingFieldView["after"] }) {
  return plain(value) ? (
    <span className="rounded-sm bg-added-bg px-1 text-added-fg [&_*]:text-added-fg">
      <Value value={value} />
    </span>
  ) : (
    <Value value={value} />
  );
}

/** A value's before and after as a sentence: "Status  Lead → Qualified", with what it is now where it changed since. */
export function FieldList({ fields }: { fields: PendingFieldView[] }) {
  const t = useTranslations("review");
  return (
    <dl className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {fields.map((f) => (
        <div key={fieldKey(f)} className="contents">
          <dt className="truncate text-fg-muted">{f.property?.name ?? t("title")}</dt>
          <dd className="min-w-0">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {f.before && f.before.type !== "empty" && (
                <>
                  <Before value={f.before} />
                  <ArrowRight aria-label={t("becomes")} className="h-3.5 w-3.5 shrink-0 text-fg-faint rtl:-scale-x-100" />
                </>
              )}
              <After value={f.after} />
            </span>
            {f.conflict && <ConflictNote field={f} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ConflictNote({ field }: { field: PendingFieldView }) {
  const t = useTranslations("review");
  return (
    <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span>{t.rich("changedSince", { value: () => <Value value={field.now ?? { type: "empty" }} /> })}</span>
    </p>
  );
}

/** An email draft: who it goes to and from, its subject and text. */
export function EmailPreview({ email }: { email: NonNullable<PendingChangeView["email"]> }) {
  const t = useTranslations("review.email");
  const line = (label: string, value: string) => (
    <div className="flex gap-2">
      <span className="w-16 shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
  return (
    <div className="rounded-md border border-border text-sm">
      <div className="space-y-0.5 border-b border-border px-3 py-2">
        {line(t("from"), email.sender.name)}
        {line(t("to"), email.to.join(", "))}
        {email.cc.length > 0 && line(t("cc"), email.cc.join(", "))}
        {line(t("subject"), email.subject)}
        {email.replyTo && <p className="text-xs text-fg-muted">{t("reply")}</p>}
      </div>
      <p className="max-h-72 overflow-y-auto px-3 py-2 whitespace-pre-wrap">{email.text}</p>
    </div>
  );
}

/**
 * An automation's approval: its message, who may answer, and what approving lets the run do next
 * (the steps after it in the version the run is pinned to), and what happens without an answer.
 */
export function ApprovalPreview({ approval }: { approval: NonNullable<PendingChangeView["approval"]> }) {
  const t = useTranslations("review.approval");
  const tType = useTranslations("database.automations.form.actionType");
  const format = useFormatter();
  const detail = (s: (typeof approval.nextSteps)[number]) =>
    s.type === "wait" && s.detail ? format.number(Number(s.detail), { style: "unit", unit: "minute", unitDisplay: "long" }) : s.detail;
  return (
    <div className="space-y-2 text-sm">
      {approval.message && <p className="border-s-2 border-border ps-3 whitespace-pre-wrap text-fg-muted">{approval.message}</p>}
      <div className="rounded-md border border-border">
        <p className="border-b border-border px-3 py-1.5 text-xs text-fg-muted">
          {approval.nextSteps.length ? t("next") : t("nothingNext")}
        </p>
        {approval.nextSteps.length > 0 && (
          <ol className="space-y-1 px-3 py-2">
            {approval.nextSteps.map((s) => (
              <li key={s.id} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-medium">{tType.has(s.type as never) ? tType(s.type as never) : s.type}</span>
                {(s.detail || s.forEach) && (
                  <span className="min-w-0 truncate text-fg-muted">
                    {[detail(s), s.forEach ? t("forEach", { step: s.forEach }) : null].filter(Boolean).join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {t("approvers", { names: format.list(approval.approvers.map((a) => a.name || "?"), { type: "disjunction" }) })}
        {" · "}
        {approval.onTimeout === "continue" ? t("timeoutContinue") : t("timeoutStop")}
      </p>
    </div>
  );
}

/** Why an approved change couldn't be made, in the reviewer's words. */
function useFailure() {
  const t = useTranslations("review.failed");
  const tm = useTranslations("settings.email.errors");
  return (error: string | null) => {
    if (!error || error === "error") return t("error");
    if (error === "pageLocked") return t("pageLocked");
    if (error.startsWith("mail:")) {
      const code = error.slice(5);
      return tm.has(code as never) ? tm(code as never) : t("error");
    }
    return error;
  };
}

type Edit = { values: Record<string, { keep: boolean; value: string | boolean }>; markdown: string; subject: string; text: string };

function startEdit(change: PendingChangeView): Edit {
  const values: Edit["values"] = {};
  for (const f of change.fields) {
    values[fieldKey(f)] = { keep: true, value: typeof f.raw === "boolean" ? f.raw : f.raw === null || f.raw === undefined ? "" : String(f.raw) };
  }
  return { values, markdown: change.markdown ?? "", subject: change.email?.subject ?? "", text: change.email?.text ?? "" };
}

/** The edit as the server takes it: the values kept, each as written. */
function editPayload(change: PendingChangeView, edit: Edit): unknown {
  if (change.kind === "email_draft") return { subject: edit.subject, text: edit.text };
  const out: { title?: string; properties: Record<string, unknown>; markdown?: string } = { properties: {} };
  for (const f of change.fields) {
    const e = edit.values[fieldKey(f)];
    if (!e?.keep) continue;
    const value = editable(f) ? (f.property?.type === "number" && typeof e.value === "string" ? (e.value.trim() === "" ? null : Number(e.value)) : e.value) : f.raw;
    if (f.property) out.properties[f.property.id] = value;
    else out.title = String(value);
  }
  if (change.kind === "create_row") out.markdown = edit.markdown;
  return out;
}

function EditForm({ change, edit, onChange }: { change: PendingChangeView; edit: Edit; onChange: (edit: Edit) => void }) {
  const t = useTranslations("review");
  const te = useTranslations("review.email");
  if (change.kind === "email_draft") {
    return (
      <div className="space-y-2 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{te("subject")}</span>
          <Input value={edit.subject} onChange={(e) => onChange({ ...edit, subject: e.target.value.replace(/[\r\n]+/g, " ") })} className="w-full" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{te("text")}</span>
          <textarea rows={8} value={edit.text} onChange={(e) => onChange({ ...edit, text: e.target.value })} className={textareaClass} />
        </label>
      </div>
    );
  }
  const set = (key: string, patch: Partial<Edit["values"][string]>) => onChange({ ...edit, values: { ...edit.values, [key]: { ...edit.values[key], ...patch } } });
  return (
    <div className="space-y-2 text-sm">
      {change.fields.map((f) => {
        const key = fieldKey(f);
        const e = edit.values[key];
        const label = f.property?.name ?? t("title");
        // A new row keeps its title; any other value may be left out of the change.
        const required = f.property === null && change.kind === "create_row";
        return (
          <div key={key} className="grid grid-cols-[minmax(6rem,max-content)_1fr_auto] items-center gap-x-3">
            <span className={cn("truncate", e.keep ? "text-fg-muted" : "text-fg-faint line-through")}>{label}</span>
            <span className={cn("min-w-0", !e.keep && "opacity-50")}>
              {!editable(f) ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Value value={f.after} />
                  <span className="text-xs text-fg-faint">{t("notEditable")}</span>
                </span>
              ) : f.property?.type === "checkbox" ? (
                <input type="checkbox" aria-label={label} disabled={!e.keep} checked={e.value === true} onChange={(ev) => set(key, { value: ev.target.checked })} />
              ) : (
                <Input
                  aria-label={label}
                  disabled={!e.keep}
                  type={f.property?.type === "number" ? "number" : f.property?.type === "date" ? "text" : "text"}
                  value={String(e.value)}
                  onChange={(ev) => set(key, { value: ev.target.value })}
                  className="w-full"
                />
              )}
            </span>
            {!required && (
              <Button size="sm" variant="ghost" onClick={() => set(key, { keep: !e.keep })}>
                {e.keep ? t("leaveOut") : t("keep")}
              </Button>
            )}
          </div>
        );
      })}
      {change.kind === "create_row" && (
        <label className="block pt-1">
          <span className="mb-1 block text-xs text-fg-muted">{t("markdown")}</span>
          <textarea rows={5} value={edit.markdown} onChange={(ev) => onChange({ ...edit, markdown: ev.target.value })} className={textareaClass} />
        </label>
      )}
    </div>
  );
}

/**
 * A change's body and its answers: the values or email, and Approve, Edit and Dismiss for whoever
 * may answer it. `onChanged` gets the change as it is after an answer (approved, dismissed, edited
 * or failed), or null when it went away meanwhile.
 */
export function ChangeBody({
  change,
  onChanged,
}: {
  change: PendingChangeView;
  onChanged: (next: PendingChangeView | null, id: string) => void;
}) {
  const t = useTranslations("review");
  const tc = useTranslations("common");
  const failure = useFailure();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = change.status === "pending" || change.status === "failed";

  async function act(kind: "approve" | "dismiss" | "save") {
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === "dismiss"
          ? await dismissPendingChangeAction(change.id)
          : kind === "save"
            ? await editPendingChangeAction(change.id, editPayload(change, edit!))
            : await approvePendingChangeAction(change.id, { edit: edit ? editPayload(change, edit) : undefined, force: change.conflict });
      if (result.ok) {
        setEdit(null);
        onChanged(result.data, change.id);
      } else {
        setError(result.error);
        if (result.code === "notFound" || result.code === "decided") onChanged(null, change.id);
      }
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const approveLabel = change.kind === "email_draft" ? t("send") : change.conflict ? t("approveAnyway") : t("approve");
  const approval = change.approval;
  return (
    <div className="space-y-3">
      {change.reason && !approval && <p className="border-s-2 border-border ps-3 text-sm text-fg-muted">{change.reason}</p>}
      {approval ? (
        <ApprovalPreview approval={approval} />
      ) : edit ? (
        <EditForm change={change} edit={edit} onChange={setEdit} />
      ) : change.email ? (
        <EmailPreview email={change.email} />
      ) : (
        <FieldList fields={change.fields} />
      )}
      {!edit && change.markdown && change.kind === "create_row" && (
        <p className="line-clamp-3 text-sm whitespace-pre-wrap text-fg-muted">{change.markdown}</p>
      )}
      {change.status === "failed" && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("failedNote", { error: failure(change.error) })}
        </p>
      )}
      {open && change.conflict && !edit && <p className="text-sm text-fg-muted">{t("conflictNotice")}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {open &&
        (change.canApprove ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act("approve")}>
              <Check className="h-3.5 w-3.5" /> {approveLabel}
            </Button>
            {approval ? (
              // An approval can't be edited: it is approved (the run goes on) or rejected (it stops).
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("dismiss")}>
                <X className="h-3.5 w-3.5" /> {t("reject")}
              </Button>
            ) : edit ? (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("save")}>
                  {t("save")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit(null)}>
                  {tc("cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEdit(startEdit(change))}>
                  <Pencil className="h-3.5 w-3.5" /> {t("edit")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("dismiss")}>
                  <X className="h-3.5 w-3.5" /> {t("dismiss")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            {change.kind === "email_draft"
              ? t("cannot.email", { name: change.email?.sender.name ?? t("someone") })
              : approval
                ? t("cannot.approval")
                : t("cannot.row")}
          </p>
        ))}
    </div>
  );
}
