import type { SenderAuth } from "./sender-marks";
import { PUBLIC_EMAIL_DOMAINS } from "./sso-config";

/**
 * Whether a message's images from other sites load when it is opened (server/mail-client/read.ts).
 * They tell the sender the mail was read, and from where, so they stay out unless the owner asked
 * for them on this message (or another copy of it, in another folder), always loads them from this
 * sender, or the sender writes from the mailbox's own organization. A From address is anyone's to
 * write, so what the provider's check (`Authentication-Results`, lib/sender-marks.ts) says of the
 * message decides how far that goes: a copy's memory and trust in a sender hold while it doesn't
 * say the mail came from someone else (DMARC failed); the mailbox's own domain, which the owner
 * never chose, only when the provider itself says the domain vouched for it (DMARC passed, which
 * only a Google or Microsoft mailbox's provider is known to write). A message the owner asked for
 * loads them anyway.
 */

/** Why a message's images load: the owner asked (now or before), on another copy of it, trusts the sender, or it is their own domain. */
export type MailImagesFrom = "asked" | "copy" | "sender" | "domain";

export type MailImageChoice = {
  /** The owner asked for this message's images, now or on an earlier opening. */
  asked: boolean;
  /** The owner asked for them on another copy of the message (the same message in another folder). */
  rememberedCopy: boolean;
  /** The sender is on the mailbox's list of senders whose images always load. */
  trustedSender: boolean;
  mailboxAddress: string;
  fromAddress: string;
};

const domainOf = (address: string) => address.trim().toLowerCase().split("@")[1] ?? "";

/** The sender writes from the mailbox's own organization: same domain, not a public mail service. */
export function sameOrganization(mailboxAddress: string, fromAddress: string) {
  const own = domainOf(mailboxAddress);
  return !!own && own === domainOf(fromAddress) && !PUBLIC_EMAIL_DOMAINS.has(own);
}

/** Why images might load, before the message is read; null when they stay out. */
export function imagesWanted(choice: MailImageChoice): MailImagesFrom | null {
  if (choice.asked) return "asked";
  if (choice.rememberedCopy) return "copy";
  if (choice.trustedSender) return "sender";
  if (sameOrganization(choice.mailboxAddress, choice.fromAddress)) return "domain";
  return null;
}

/** Why images load once the message is read and what the provider's check says of its sender is known; null when they stay out. */
export function imagesShown(wanted: MailImagesFrom | null, auth: SenderAuth): MailImagesFrom | null {
  if (wanted === "asked") return wanted;
  if (wanted === "domain") return auth === "pass" ? wanted : null;
  return auth !== "fail" ? wanted : null;
}
