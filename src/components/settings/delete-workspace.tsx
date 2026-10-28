"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { deleteWorkspaceAction } from "@/app/actions/workspaces";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "@/components/account/proof-fields";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Input } from "@/components/ui";
import { confirmsWorkspaceName } from "@/lib/account";
import { SettingsRow } from "./section";

/**
 * Settings > General > Delete workspace, for owners. The dialog asks for the workspace's name and
 * the same proof as deleting the account (see server/workspace-deletion.ts).
 */
export function DeleteWorkspaceRow({ workspaceId, name, proof }: { workspaceId: string; name: string; proof: ProofSetup }) {
  const t = useTranslations("settings.deleteWorkspace");
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        title={t("title")}
        description={t("description")}
        control={
          <Button variant="danger" onClick={() => setOpen(true)}>
            {t("button")}
          </Button>
        }
      />
      {open && <DeleteDialog workspaceId={workspaceId} name={name} proof={proof} onClose={() => setOpen(false)} />}
    </>
  );
}

function DeleteDialog({ workspaceId, name, proof, onClose }: { workspaceId: string; name: string; proof: ProofSetup; onClose: () => void }) {
  const t = useTranslations("settings.deleteWorkspace");
  const tc = useTranslations("common");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = confirmsWorkspaceName(typed, name);

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setError(null);
          startTransition(async () => {
            const result = await deleteWorkspaceAction(workspaceId, { confirmation: typed, proof: proofFrom(form) }).catch(() => null);
            if (!result?.ok) return setError(result?.error ?? tc("genericError"));
            // A full load: the sidebar, the switcher and cached pages all still show the workspace.
            window.location.href = "/";
          });
        }}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("dialogTitle", { name })}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("dialogBody")}</p>
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("typeName", { name })}</span>
            <Input
              name="confirmation"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <ProofFields proof={proof} returnTo={`/w/${workspaceId}/settings?tab=general`} />
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={pending || !matches || !canProve(proof)}>
            {pending ? t("deleting") : t("confirm")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
