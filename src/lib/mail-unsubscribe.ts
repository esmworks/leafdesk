import { normalizeAddress } from "./mail";
import type { MailUnsubscribe } from "./mail-client";

/**
 * A mailing list's ways out, read from its message's List-Unsubscribe header (RFC 2369): a web
 * address, an address to mail, and whether the web address takes a POST without a visit
 * (List-Unsubscribe-Post: List-Unsubscribe=One-Click, RFC 8058).
 */
export type UnsubscribeTargets = {
  https: string | null;
  mail: { address: string; subject: string; body: string } | null;
  oneClick: boolean;
};

const MAX_URL = 2000;
const MAX_FIELD = 200;

export function unsubscribeTargets(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): UnsubscribeTargets {
  const entries = [...(listUnsubscribe ?? "").matchAll(/<([^<>]{1,2000})>/g)].map((m) => m[1].replace(/\s+/g, ""));
  const https =
    entries.find((entry) => {
      if (entry.length > MAX_URL || !/^https:\/\//i.test(entry)) return false;
      try {
        return !!new URL(entry).hostname;
      } catch {
        return false;
      }
    }) ?? null;
  return { https, mail: mailtoOf(entries.find((entry) => /^mailto:/i.test(entry))), oneClick: !!https && /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(listUnsubscribePost ?? "") };
}

/** A mailto: link's address, subject and body; null when its address isn't one. */
function mailtoOf(link: string | undefined): UnsubscribeTargets["mail"] {
  if (!link || link.length > MAX_URL) return null;
  const [path, query = ""] = link.slice("mailto:".length).split("?", 2);
  let address: string | null;
  let params: URLSearchParams;
  try {
    address = normalizeAddress(decodeURIComponent(path));
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  // One address (normalizeAddress takes no list): the way out writes to the list's robot alone.
  if (!address) return null;
  const field = (name: string) => [...params].find(([key]) => key.toLowerCase() === name)?.[1].slice(0, MAX_FIELD).replace(/[\r\n]+/g, " ").trim() ?? "";
  return { address, subject: field("subject"), body: field("body") };
}

/**
 * What the Mail tab offers for a message: unsubscribing on the spot (the one-click POST, else a
 * mail to the list) from a sender that passed the provider's check, else the web address to visit.
 * A sender that failed it may not be the list: nothing goes to it without the person's own visit.
 */
export function unsubscribeOffer(targets: UnsubscribeTargets, unverifiedSender: boolean): MailUnsubscribe | null {
  if (!unverifiedSender && targets.oneClick) return { how: "oneClick" };
  if (!unverifiedSender && targets.mail) return { how: "mail", address: targets.mail.address };
  return targets.https ? { how: "web", url: targets.https } : null;
}
