"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { decideApprovalAction } from "@/app/actions/connections";
import { Button, textareaClass } from "@/components/ui";
import type { ApprovalDecision } from "@/lib/agents";
import { MAX_REDO_NOTE } from "@/lib/connections";

/**
 * An owner's answer to the call an agent waits to make on a connection: what it would send, and
 * approve (sent as shown), decline (nothing is sent) or send back with a note (the agent prepares
 * it again and asks again). Used in the inbox and in an agent's runs. Approve is offered only where
 * the input shown is all of what would be sent (`whole`, unless false): the inbox cuts long calls
 * short and masks credentials, so there such a call is approved from its run (`onOpenRun`).
 */
export function ApprovalActions({
  workspaceId,
  approval,
  onAnswered,
  onOpenRun,
  className,
}: {
  workspaceId: string;
  approval: { runId: string; callId: string; tool: string; connectionName: string; input: string; whole?: boolean };
  onAnswered: (decision: ApprovalDecision) => void;
  /** Opens the call's run, where all of it shows (for a call not shown whole here). */
  onOpenRun?: () => void;
  className?: string;
}) {
  const t = useTranslations("settings.connections.approval");
  const tc = useTranslations("common");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redo, setRedo] = useState(false);
  const [note, setNote] = useState("");
  const whole = approval.whole !== false;

  const answer = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      const result = await decideApprovalAction(workspaceId, { runId: approval.runId, callId: approval.callId, decision, note: decision === "redo" ? note : undefined });
      if (result.ok) onAnswered(decision);
      else setError(result.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <p className="mb-1 text-xs text-fg-muted">{t("wouldSend", { tool: approval.tool, connection: approval.connectionName || t("removedConnection") })}</p>
      <pre className="mb-2 max-h-48 overflow-auto rounded-md border border-border bg-bg-hover px-2.5 py-2 text-xs break-words whitespace-pre-wrap">{approval.input}</pre>
      {!whole && <p className="mb-2 text-xs text-fg-muted">{t("notWhole")}</p>}
      {redo ? (
        <div className="space-y-1.5">
          <label className="block text-xs text-fg-muted" htmlFor={`redo-${approval.callId}`}>
            {t("noteLabel")}
          </label>
          <textarea
            id={`redo-${approval.callId}`}
            value={note}
            maxLength={MAX_REDO_NOTE}
            rows={2}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("notePlaceholder")}
            className={textareaClass}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={busy || !note.trim()} onClick={() => void answer("redo")}>
              {t("sendBack")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRedo(false)}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {whole ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void answer("approve")}>
              {t("approve")}
            </Button>
          ) : (
            onOpenRun && (
              <Button size="sm" variant="primary" disabled={busy} onClick={onOpenRun}>
                {t("openRun")}
              </Button>
            )
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void answer("decline")}>
            {t("decline")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRedo(true)}>
            {t("redo")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
