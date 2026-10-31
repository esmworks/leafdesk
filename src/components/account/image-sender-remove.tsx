"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { forgetImageSenderAction } from "@/app/actions/mail";
import { Button } from "@/components/ui";

/** Stops always loading a sender's images: they wait to be asked for again. Undone from a message. */
export function ImageSenderRemove({ mailboxId, address }: { mailboxId: string; address: string }) {
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
            const result = await forgetImageSenderAction({ mailboxId, address }).catch(() => null);
            if (result?.ok) router.refresh();
            else setError(result?.error ?? t("removeImageSenderError"));
          })
        }
      >
        {t("removeImageSender")}
      </Button>
    </div>
  );
}
