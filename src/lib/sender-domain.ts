/**
 * The domain of an address, lower case; null without one. A module of its own, import-free, for
 * the Mail page's first load (lib/mail-senders.ts carries the list of public mail services).
 */
export function senderDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
  return domain.includes(".") ? domain : null;
}
