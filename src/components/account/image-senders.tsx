import { getTranslations } from "next-intl/server";
import { ImageIcon } from "lucide-react";
import { SettingsGroup } from "@/components/settings/section";
import { listImageSenders } from "@/server/mail-client/images";
import { ImageSenderRemove } from "./image-sender-remove";

/**
 * Account > Mail: the senders whose images from other sites the person's mailboxes always load
 * (server/mail-client/images.ts), each with a way to stop. Senders are added from a message.
 */
export async function ImageSenders({ userId }: { userId: string }) {
  const [senders, t] = await Promise.all([listImageSenders(userId), getTranslations("account.mail")]);
  const mailboxes = new Set(senders.map((s) => s.mailboxId));
  return (
    <SettingsGroup anchor="imageSenders" title={t("imageSendersHeading")} description={t("imageSendersDescription")}>
      {senders.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("imageSendersEmpty")}</p>
      ) : (
        senders.map((sender) => (
          <div key={`${sender.mailboxId}:${sender.address}`} className="flex items-center gap-3 px-5 py-3">
            <ImageIcon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{sender.address}</div>
              {/* With one mailbox there is nothing to tell apart. */}
              {mailboxes.size > 1 && <div className="truncate text-xs text-fg-muted">{t("imageSenderTo", { mailbox: sender.mailbox })}</div>}
            </div>
            <ImageSenderRemove mailboxId={sender.mailboxId} address={sender.address} />
          </div>
        ))
      )}
    </SettingsGroup>
  );
}
