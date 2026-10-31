import { PUBLIC_EMAIL_DOMAINS } from "./sso-config";

/**
 * Whether a message's images from other sites load when it is opened (server/mail-client/read.ts).
 * They tell the sender the mail was read, and from where, so they stay out unless the owner asked
 * for them on this message, always loads them from this sender, or the sender writes from the
 * mailbox's own organization. Trust in a sender holds only while the provider's check doesn't say
 * the mail came from someone else (DMARC failed); a message the owner asked for loads them anyway.
 */

/** Why a message's images load: the owner asked (now or before), trusts the sender, or it is their own domain. */
export type MailImagesFrom = "asked" | "sender" | "domain";

export type MailImageChoice = {
  /** The owner asked for this message's images, now or on an earlier opening. */
  asked: boolean;
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
  if (choice.trustedSender) return "sender";
  if (sameOrganization(choice.mailboxAddress, choice.fromAddress)) return "domain";
  return null;
}

/** Why images load once the message is read and its sender checked; null when they stay out. */
export function imagesShown(wanted: MailImagesFrom | null, unverifiedSender: boolean): MailImagesFrom | null {
  return wanted === "asked" || !unverifiedSender ? wanted : null;
}
