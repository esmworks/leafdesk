"use client";

import { Share, SquarePlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";

/**
 * How to install Leafdesk on an iPhone or iPad, where browsers offer no install prompt: only the
 * Share menu's "Add to Home Screen" (install-app.tsx opens it from the "Install app" menu item).
 */
export function IosInstallHelp({ onClose }: { onClose: () => void }) {
  const t = useTranslations("offline.iosInstall");
  const tc = useTranslations("common");
  return (
    <Dialog open onClose={onClose} className="max-w-sm">
      <DialogHeader title={t("title")} onClose={onClose} closeLabel={tc("close")} />
      <DialogBody className="space-y-3 text-sm">
        <p className="flex items-start gap-3">
          <Share aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          {t("share")}
        </p>
        <p className="flex items-start gap-3">
          <SquarePlus aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          {t("add")}
        </p>
        <p className="text-fg-muted">{t("done")}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          {tc("close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
