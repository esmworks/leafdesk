"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { createWorkspaceAction } from "@/app/actions/workspaces";
import { Button, Dialog, Input } from "@/components/ui";
import { RestoreBackup } from "./restore-backup";

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const t = useTranslations("sidebar.newWorkspace");
  const tc = useTranslations("common");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  function close() {
    // A restore can't be called off halfway; the dialog stays until it's over.
    if (restoring) return;
    setName("");
    setError(null);
    setRestored(false);
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} className="max-w-md">
      <form
        className={restored ? "hidden" : "space-y-3 p-5"}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await createWorkspaceAction(name);
            if (!result.ok) return setError(result.error);
            close();
            router.push(`/w/${result.data}`);
          });
        }}
      >
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-sm text-fg-muted">{t("description")}</p>
        <Input autoFocus placeholder={t("namePlaceholder")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
            {pending ? t("creating") : t("create")}
          </Button>
        </div>
      </form>
      <div className={restored ? "p-5" : "px-5 pb-5"}>
        <RestoreBackup onBusy={setRestoring} onRestored={() => setRestored(true)} onDone={close} />
      </div>
    </Dialog>
  );
}
