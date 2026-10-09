"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { requestAccessAction } from "@/app/actions/access-requests";
import { Button, cn, textareaClass } from "@/components/ui";
import { ACCESS_REQUEST_MESSAGE_MAX } from "@/lib/access-requests";

/**
 * What a signed-in person sees for a page they can't open, and for a page that doesn't exist: the
 * two must look the same, so nothing here comes from the page (no title, icon or workspace). With
 * requests on, they can ask for access with an optional message; the answer is always "sent".
 */
export function NoAccess({ pageId, email, canRequest }: { pageId: string; email: string; canRequest: boolean }) {
  const t = useTranslations("page.noAccess");
  const tc = useTranslations("common");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sent" | "rateLimited" | "error">("idle");
  const [pending, startTransition] = useTransition();

  const send = () =>
    startTransition(async () => {
      try {
        setState(await requestAccessAction(pageId, message));
      } catch {
        setState("error");
      }
    });

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-bg-hover text-fg-muted">
          <Lock className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-xl font-semibold">{state === "sent" ? t("sentTitle") : t("title")}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {state === "sent" ? t("sentDescription") : canRequest ? t("description") : t("descriptionNoRequests")}
        </p>
        {canRequest && state !== "sent" && (
          <form
            className="mt-6 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="access-request-message" className="block text-sm font-medium">
              {t("messageLabel")}
            </label>
            <textarea
              id="access-request-message"
              value={message}
              maxLength={ACCESS_REQUEST_MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("messagePlaceholder")}
              rows={3}
              className={cn("block", textareaClass)}
            />
            {state === "rateLimited" && (
              <p role="alert" className="text-sm text-danger">
                {t("rateLimited")}
              </p>
            )}
            {state === "error" && (
              <p role="alert" className="text-sm text-danger">
                {tc("genericError")}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? t("sending") : t("request")}
            </Button>
          </form>
        )}
        <p className="mt-8 border-t border-border pt-4 text-xs text-fg-muted">
          {t("signedInAs", { email })}{" "}
          <Link href="/" className="text-accent hover:underline">
            {t("home")}
          </Link>
        </p>
      </div>
    </div>
  );
}
