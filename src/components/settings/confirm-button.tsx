"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";

/**
 * A button that asks before it acts: a second click on the danger button runs `act`, then the page
 * refreshes. `act` returns an error to show, or null; a throw shows `failed`.
 */
export function ConfirmButton({
  label,
  confirmLabel = label,
  working,
  note,
  failed,
  act,
}: {
  label: string;
  confirmLabel?: string;
  working: string;
  /** What acting will do, shown while asking. */
  note?: string;
  failed: string;
  act: () => Promise<string | null>;
}) {
  const router = useRouter();
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <Button size="sm" className="shrink-0 self-start" onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 sm:max-w-64 sm:items-end">
      {note && <p className="text-xs text-fg-muted sm:text-end">{note}</p>}
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              try {
                const problem = await act();
                if (problem) setError(problem);
                else router.refresh();
              } catch {
                setError(failed);
              }
            })
          }
        >
          {pending ? working : confirmLabel}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
