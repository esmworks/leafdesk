/**
 * A signature pasted from another mail program, kept as it came: its images, table layout, sizes
 * and colors, which the Mail tab's editor can't hold. It is stored in `mailbox.signature` inside
 * `<div data-pasted="">`, cleaned to `PASTED_SIGNATURE_CONFIG` (pasted-signature-config.ts, apart
 * so the settings page's first load goes without it) by server/mail-client/outgoing.ts when saved
 * and again when sent; the settings and the composer show it with components/mail/pasted-signature.tsx.
 */

const OPEN = '<div data-pasted="">';
const CLOSE = "</div>";

/** What is pasted is kept as it is when the editor would lose some of it: its images or its layout. */
export const RICH_PASTE = /<(img|table)\b/i;

export const wrapPasted = (html: string) => `${OPEN}${html}${CLOSE}`;

/** A stored signature's pasted HTML, or null for one written in the editor. */
export const pastedHtml = (signature: string | null | undefined) =>
  signature?.startsWith(OPEN) && signature.endsWith(CLOSE) ? signature.slice(OPEN.length, -CLOSE.length) : null;
