"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { RestoreResult } from "@/lib/backup";

type State =
  | { step: "idle"; error?: string }
  | { step: "uploading"; percent: number }
  | { step: "restoring" }
  | { step: "done"; result: RestoreResult };

const ERRORS = ["invalid", "newer", "alreadyHere", "notAllowed", "quota", "conflict", "busy", "tooLarge"] as const;

/** Sends `file` to the restore route, reporting the upload's progress (fetch can't). */
function upload(file: File, onProgress: (percent: number) => void, onSent: () => void) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/backups");
    request.setRequestHeader("X-Leafdesk-Restore", "1");
    request.setRequestHeader("Content-Type", "application/zip");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.upload.onload = onSent;
    request.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText);
      } catch {}
      resolve({ status: request.status, body });
    };
    request.onerror = () => reject(new Error("network"));
    request.send(file);
  });
}

/**
 * Restoring a workspace from a backup file (Settings > General > Back up workspace, on this or
 * another Leafdesk), in the new workspace dialog. Shows what to set up again once it's in.
 */
export function RestoreBackup({
  onBusy,
  onRestored,
  onDone,
}: {
  onBusy: (busy: boolean) => void;
  onRestored: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const t = useTranslations("sidebar.newWorkspace.restore");
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: "idle" });

  async function restore(file: File) {
    onBusy(true);
    setState({ step: "uploading", percent: 0 });
    try {
      const { status, body } = await upload(
        file,
        (percent) => setState({ step: "uploading", percent }),
        () => setState({ step: "restoring" }),
      );
      if (status === 201) {
        onRestored();
        return setState({ step: "done", result: body as RestoreResult });
      }
      const code = (body as { error?: string } | null)?.error;
      const known = ERRORS.find((e) => e === code);
      setState({ step: "idle", error: known ? t(`errors.${known}`) : t("errors.failed") });
    } catch {
      setState({ step: "idle", error: t("errors.failed") });
    } finally {
      onBusy(false);
    }
  }

  if (state.step === "done") {
    const { result } = state;
    const notes = [
      result.withoutAccount.length > 0 && (
        <li key="people">
          {t("withoutAccount", { count: result.withoutAccount.length })}
          <ul className="mt-1 space-y-0.5 text-fg-muted">
            {result.withoutAccount.slice(0, 8).map((p) => (
              <li key={p.email} className="truncate">
                {p.name ? `${p.name} · ${p.email}` : p.email}
              </li>
            ))}
            {result.withoutAccount.length > 8 && <li>{t("andMore", { count: result.withoutAccount.length - 8 })}</li>}
          </ul>
        </li>
      ),
      result.connectionsToReconnect > 0 && <li key="connections">{t("connections", { count: result.connectionsToReconnect })}</li>,
      result.ssoOnlyTurnedOff && <li key="sso">{t("ssoOnlyTurnedOff")}</li>,
      result.siteLeftOut && <li key="site">{t("siteLeftOut")}</li>,
      result.searchIndexDropped && <li key="search">{t("searchIndexDropped")}</li>,
    ].filter(Boolean);
    return (
      <div className="space-y-3">
        <p className="text-sm" role="status">
          {t("done", { name: result.name, pages: result.pages, files: result.files })}
        </p>
        {notes.length > 0 && <ul className="list-disc space-y-2 ps-5 text-sm">{notes}</ul>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={() => {
              onDone();
              router.push(`/w/${result.workspaceId}`);
              router.refresh();
            }}
          >
            {t("open")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {state.step === "uploading"
            ? t("uploading", { percent: state.percent })
            : state.step === "restoring"
              ? t("restoring")
              : t("description")}
        </p>
        <Button onClick={() => input.current?.click()} disabled={state.step !== "idle"} className="shrink-0">
          {t("choose")}
        </Button>
      </div>
      {state.step === "idle" && state.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void restore(file);
        }}
      />
    </div>
  );
}
