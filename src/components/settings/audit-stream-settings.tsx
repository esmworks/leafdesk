"use client";

/**
 * Settings > Audit log > Stream to your security tools (owners): where the workspace's new audit
 * events go as they happen (server/audit-stream.ts), how sending goes, a test event, and the
 * signing secret, shown once when it is made.
 */
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  removeAuditStreamAction,
  replaceAuditStreamSecretAction,
  saveAuditStreamAction,
  sendAuditStreamTestAction,
} from "@/app/actions/audit-stream";
import { ConfirmButton } from "@/components/settings/confirm-button";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, cn, Dialog, IconButton, Input, Switch } from "@/components/ui";
import type { AuditStreamView, StreamSendResult } from "@/server/audit-stream";

type Translate = ReturnType<typeof useTranslations<"settings.eventStream">>;

function reasonText(t: Translate, code: string | null, httpStatus: number | null) {
  if (code === "http" || (!code && httpStatus)) return t("codes.http", { status: httpStatus ?? 0 });
  return code ? t(`codes.${code as "blocked"}`) : "";
}

export function AuditStreamSettings({ workspaceId, stream }: { workspaceId: string; stream: AuditStreamView | null }) {
  const t = useTranslations("settings.eventStream");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [url, setUrl] = useState(stream?.url ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [test, setTest] = useState<StreamSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = <T,>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, then?: (data: T) => void) =>
    startTransition(async () => {
      setError(null);
      setTest(null);
      const result = await work();
      if (!result.ok) return setError(result.error);
      then?.(result.data);
      router.refresh();
    });

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const status = stream?.status;
  const failing = Boolean(status?.failingSince);

  return (
    <div className="divide-y divide-border">
      <form
        className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => saveAuditStreamAction(workspaceId, { url }), (data) => data.secret && setSecret(data.secret));
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          <span className="mb-1 block font-medium">{t("url")}</span>
          <Input type="url" value={url} placeholder="https://siem.example.com/leafdesk" onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <Button type="submit" variant={stream ? "secondary" : "primary"} disabled={pending || !url.trim() || url.trim() === stream?.url}>
          {stream ? t("saveUrl") : t("start")}
        </Button>
      </form>

      {!stream && <p className="px-5 py-4 text-sm text-fg-muted">{t("how")}</p>}

      {stream && status && (
        <>
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-6" data-audit-stream-status>
            <div className="min-w-0 flex-1 space-y-1 text-sm">
              <p className={cn("font-medium", stream.enabled && failing && "text-danger")}>
                {!stream.enabled ? t("state.off") : failing ? t("state.failing", { since: when(status.failingSince!) }) : t("state.on")}
              </p>
              {stream.enabled && failing && status.lastError && (
                <p className="text-danger">
                  {reasonText(t, status.lastErrorCode, status.lastHttpStatus)}
                  {status.nextAttemptAt && ` · ${t("nextTry", { when: when(status.nextAttemptAt) })}`}
                </p>
              )}
              <p className="text-fg-muted">
                {status.lastSuccessAt ? t("lastSuccess", { when: when(status.lastSuccessAt) }) : t("noSuccess")}
                {" · "}
                {t("sent", { count: status.sentEvents })}
                {status.waiting > 0 && ` · ${t("waiting", { count: status.waiting })}`}
              </p>
              {status.droppedEvents > 0 && status.lastDroppedAt && (
                <p className="text-danger">{t("dropped", { count: status.droppedEvents, when: when(status.lastDroppedAt) })}</p>
              )}
            </div>
            <Switch
              checked={stream.enabled}
              disabled={pending}
              label={t("toggle")}
              onChange={(enabled: boolean) => act(() => saveAuditStreamAction(workspaceId, { enabled }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
            <Button size="sm" disabled={pending} onClick={() => act(() => sendAuditStreamTestAction(workspaceId), setTest)}>
              {t("test")}
            </Button>
            <ConfirmButton
              label={t("rotate")}
              note={t("rotateNote")}
              working={t("working")}
              failed={tc("genericError")}
              act={async () => {
                const result = await replaceAuditStreamSecretAction(workspaceId);
                if (!result.ok) return result.error;
                setSecret(result.data);
                return null;
              }}
            />
            <ConfirmButton
              label={t("remove")}
              note={t("removeNote")}
              working={t("working")}
              failed={tc("genericError")}
              act={async () => {
                const result = await removeAuditStreamAction(workspaceId);
                if (result.ok) setUrl("");
                return result.ok ? null : result.error;
              }}
            />
          </div>
          <p className="px-5 py-3 text-xs text-fg-muted">{t("how")}</p>
        </>
      )}

      {(test || error) && (
        <p role="status" className={cn("px-5 py-2 text-xs", error || (test && !test.ok) ? "text-danger" : "text-fg-muted")}>
          {error ?? (test && (test.ok ? t("testDelivered", { status: test.httpStatus }) : t("testFailed", { reason: reasonText(t, test.code, test.httpStatus) })))}
        </p>
      )}

      {secret && (
        <Dialog open onClose={() => setSecret(null)} className="max-w-lg">
          <div className="flex items-start gap-2 border-b border-border px-4 py-3">
            <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("secret.title")}</h2>
            <IconButton label={tc("close")} onClick={() => setSecret(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="space-y-3 p-4 text-sm">
            <p className="text-fg-muted">{t("secret.note")}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={secret} aria-label={t("secret.label")} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={secret} />
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
