"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";
import { previewTeamspaceFromPageAction, turnPageIntoTeamspaceAction } from "@/app/actions/teamspaces";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input } from "@/components/ui";
import type { TeamspaceFromPagePreview } from "@/server/teamspace-from-page";

/**
 * The page menu's "Turn into teamspace": says what will happen (the pages that move, who joins and
 * as what, who keeps their access, how open the teamspace is) and does it on confirmation
 * (server/teamspace-from-page.ts). Loaded with its first use, not with every page.
 */
export default function TurnIntoTeamspaceDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const t = useTranslations("teamspaces");
  const tc = useTranslations("common");
  const router = useRouter();
  const [preview, setPreview] = useState<TeamspaceFromPagePreview | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    previewTeamspaceFromPageAction(pageId)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setPreview(result.data);
          setName(result.data.name);
        } else setError(result.error);
      })
      .catch(() => live && setError(t("fromPage.failed")));
    return () => {
      live = false;
    };
  }, [pageId, t]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setWorking(true);
    setError(null);
    const result = await turnPageIntoTeamspaceAction(workspaceId, pageId, name).catch(() => null);
    if (!result?.ok) {
      setWorking(false);
      setError(result?.error ?? t("fromPage.failed"));
      return;
    }
    onClose();
    router.refresh();
  };

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <form onSubmit={(e) => void submit(e)}>
        <DialogHeader title={t("fromPage.title")} onClose={onClose} closeLabel={tc("close")} />
        <DialogBody className="text-sm">
          <p className="text-fg-muted">{t("fromPage.intro")}</p>
          {!preview ? (
            !error && <p className="py-6 text-center text-fg-muted">{tc("loading")}</p>
          ) : (
            <>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-fg-muted">{t("dialog.name")}</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus className="w-full" />
              </label>
              <ul className="list-disc space-y-1.5 ps-5">
                <li>{t("fromPage.pages", { count: preview.pages - 1 })}</li>
                <li>{t("fromPage.owners", { names: preview.owners.join(", ") })}</li>
                {preview.members.length > 0 && <li>{t("fromPage.members", { names: preview.members.join(", ") })}</li>}
                {preview.groups > 0 && <li>{t("fromPage.groups", { count: preview.groups })}</li>}
                {preview.kept > 0 && <li>{t("fromPage.kept", { count: preview.kept })}</li>}
                <li>{t("fromPage.access", { access: t(`access.${preview.access}`), hint: t(`accessHint.${preview.access}`) })}</li>
              </ul>
            </>
          )}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!preview || working || !name.trim()}>
            {working && <Loader2 className="h-4 w-4 animate-spin" />}
            {working ? t("fromPage.working") : t("fromPage.submit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
