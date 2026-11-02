"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { removeSenderRuleAction } from "@/app/actions/mail";
import { Button } from "@/components/ui";

/** Takes a sender's rule away: their mail is sorted as it comes again. */
export function SenderRuleRemove({ sender }: { sender: string }) {
  const t = useTranslations("account.mail");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await removeSenderRuleAction({ sender }).catch(() => null);
            if (result?.ok) router.refresh();
            else setError(result?.error ?? t("removeSenderRuleError"));
          })
        }
      >
        {t("removeSenderRule")}
      </Button>
    </div>
  );
}
