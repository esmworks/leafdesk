import type { MailChange } from "@/server/mail-client/watch";

/**
 * Follows the mailboxes' inboxes as the server hears of new mail (api/mail/events), while the page
 * is in front: a tab out of sight lets its stream go (browsers allow few at once per site) and asks
 * for what came meanwhile when it comes back. `onLive` says whether the stream is open, so the tab
 * looks for itself less often then. Returns the function that stops following.
 */
export function followMail(mailboxIds: string[], onChange: (change: MailChange) => void, onLive: (live: boolean) => void) {
  const query = new URLSearchParams(mailboxIds.map((id) => ["box", id]));
  let source: EventSource | null = null;
  const close = () => {
    source?.close();
    source = null;
    onLive(false);
  };
  const open = () => {
    if (source) return;
    source = new EventSource(`/api/mail/events?${query}`);
    source.onopen = () => onLive(true);
    // It opens again by itself, unless it was refused (then the tab's own checks go on).
    source.onerror = () => onLive(false);
    source.onmessage = (event) => {
      try {
        onChange(JSON.parse(event.data) as MailChange);
      } catch {}
    };
  };
  const shown = () => (document.visibilityState === "visible" ? open() : close());
  shown();
  document.addEventListener("visibilitychange", shown);
  return () => {
    document.removeEventListener("visibilitychange", shown);
    close();
  };
}
