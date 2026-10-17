"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { deleteAccountAction } from "@/app/actions/account";
import { SettingsRow } from "@/components/settings/section";
import { Button, Dialog, Input } from "@/components/ui";
import type { DeletionPlan } from "@/lib/account";
import { canProve, ProofFields, proofFrom, type ProofSetup } from "./proof-fields";
import { wipeAllOfflineData } from "@/components/offline/offline-store";

/**
 * Account > Profile > Delete account. The dialog says what happens to each workspace; while the
 * person is the only owner of a workspace others are in, it only explains how to hand it over.
 */
export function DeleteAccountSettings({ email, plan, proof }: { email: string; plan: DeletionPlan; proof: ProofSetup }) {
  const t = useTranslations("account.delete");
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
      {open && <DeleteDialog email={email} plan={plan} proof={proof} onClose={() => setOpen(false)} />}
    </>
  );
}

function WorkspaceList({ title, items }: { title: string; items: { id: string; name: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm">{title}</p>
      <ul className="list-disc space-y-0.5 ps-5 text-sm text-fg-muted">
        {items.map((w) => (
          <li key={w.id}>{w.name}</li>
        ))}
      </ul>
    </div>
  );
}

function DeleteDialog({ email, plan, proof, onClose }: { email: string; plan: DeletionPlan; proof: ProofSetup; onClose: () => void }) {
  const t = useTranslations("account.delete");
  const tc = useTranslations("common");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const blocked = plan.blockers.length > 0;
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      {blocked ? (
        <div className="space-y-4 p-5">
          <h2 className="text-base font-semibold">{t("blockedTitle")}</h2>
          <p className="text-sm text-fg-muted">{t("blockedBody")}</p>
          <WorkspaceList title={t("blockedList")} items={plan.blockers} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              {tc("close")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setError(null);
            startTransition(async () => {
              const result = await deleteAccountAction({ confirmation: typed, proof: proofFrom(form) }).catch(() => null);
              if (!result?.ok) return setError(result?.error ?? tc("genericError"));
              // A full load: every cached page belonged to the account that is gone, and so did the
              // offline copies.
              await wipeAllOfflineData();
              window.location.href = "/sign-in";
            });
          }}
        >
          <h2 className="text-base font-semibold">{t("dialogTitle")}</h2>
          <p className="text-sm text-fg-muted">{t("dialogBody")}</p>
          <WorkspaceList title={t("deletedList")} items={plan.deleted} />
          <WorkspaceList title={t("leftList")} items={plan.left} />
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("typeEmail", { email })}</span>
            <Input
              name="confirmation"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <ProofFields proof={proof} returnTo="/account?tab=profile" />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="danger" disabled={pending || !matches || !canProve(proof)}>
              {pending ? t("deleting") : t("confirm")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
