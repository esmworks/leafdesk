"use client";

import { ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { buttonClass, IconButton } from "@/components/ui";

const DISMISSED = "leafdesk:first-admin-notice";

/**
 * Tells the first account of a new server that it is the server's administrator, and that sign-up
 * stays open until it is closed (see the admin page). Shown until dismissed, in this browser.
 */
export function FirstAdminNotice({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("admin.firstAdmin");
  // Read after mounting: the server can't know what this browser dismissed.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED) !== "1") setOpen(true);
    } catch {
      setOpen(true);
    }
  }, []);
  if (!open) return null;

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {}
  };

  return (
    <div
      role="status"
      className="fixed end-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border bg-bg p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="text-sm text-fg-muted">{t("body")}</p>
        </div>
        <IconButton label={t("dismiss")} onClick={dismiss}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="mt-3 flex justify-end">
        <Link href={`/admin?from=${encodeURIComponent(workspaceId)}`} onClick={dismiss} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("open")}
        </Link>
      </div>
    </div>
  );
}
