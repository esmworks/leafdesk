"use client";

import { Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";

// The dialog and its editor load with the button's first use (or as the pointer comes near it),
// not with every database page.
const loadDialog = () => import("./automations-dialog");
const AutomationsDialog = lazy(loadDialog);

/**
 * The database toolbar's automations button: "when a row is added, a property changes, a date
 * passes, a schedule comes round or a request arrives, do these steps". Shown to people with
 * full access to the database.
 */
export function AutomationsButton({
  workspaceId,
  databaseId,
  databaseTitle,
  openRun = null,
}: {
  workspaceId: string;
  databaseId: string;
  databaseTitle: string;
  /** A run to show when the page opens (a link from the "For review" queue): the dialog opens at it. */
  openRun?: { automationId: string; runId: string } | null;
}) {
  const t = useTranslations("database.automations");
  const [open, setOpen] = useState(openRun !== null);
  return (
    <>
      <button
        type="button"
        title={t("button")}
        aria-label={t("button")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadDialog()}
        onFocus={() => void loadDialog()}
        className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <Zap className="h-4 w-4" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        // A portal keeps the toolbar's styles out; React context (schema, people) still reaches it.
        createPortal(
          <Suspense fallback={null}>
            <AutomationsDialog
              workspaceId={workspaceId}
              databaseId={databaseId}
              databaseTitle={databaseTitle}
              openRun={openRun}
              onClose={() => setOpen(false)}
            />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
