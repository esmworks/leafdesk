/**
 * The "Send to Slack" automation step (server/automations/run.ts): a message posted to a Slack
 * incoming webhook. Its address is a secret (whoever has it can post to the channel), so it is
 * sealed when saved and only a hint of it is shown again. Pure: the address check, the hint and the
 * message Slack gets, for the server and the editor alike.
 */

export const SLACK_HOST = "hooks.slack.com";

/**
 * A Slack incoming webhook's address as typed, checked: https://hooks.slack.com/services/…, or
 * (`allowed`) any address on a host the server's administrator allows for automations, where a
 * Slack-compatible receiver on the server's own network may listen. Null when it is neither.
 */
export function slackWebhookUrl(text: unknown, allowed: (url: URL) => boolean = () => false): URL | null {
  if (typeof text !== "string" || !text.trim() || text.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:" && url.hostname === SLACK_HOST && !url.port && /^\/services\/[^/]+\/./.test(url.pathname)) return url;
  if ((url.protocol === "https:" || url.protocol === "http:") && allowed(url)) return url;
  return null;
}

/** What a saved address shows: its host and first path part, and its last four characters ("hooks.slack.com/services/…x9Ab"). */
export function slackUrlHint(url: string): string {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    const tail = parsed.pathname.replace(/\/+$/, "").slice(-4);
    return `${parsed.host}${first ? `/${first}` : ""}/…${tail}`;
  } catch {
    return "…";
  }
}

/** Text as Slack reads it literally: &, < and > written as entities (Slack's own markup uses them). */
export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Template values as a Slack message takes them: every text escaped (see escapeSlack), so a row's
 * title can't turn into a link or a mention; the message's own text keeps Slack's markup.
 */
export function escapeSlackValues<T>(value: T): T {
  if (typeof value === "string") return escapeSlack(value) as T;
  if (Array.isArray(value)) return value.map(escapeSlackValues) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeSlackValues(v)])) as T;
  return value;
}

/**
 * The JSON Slack gets: the message, and the row (or the database, for a run without one) as a
 * Slack link on a line of its own.
 */
export function slackPayload(message: string, link: { url: string; title: string } | null): { text: string } {
  const lines = [message.trim()];
  if (link && /^https?:\/\//.test(link.url)) {
    // A link's text ends at its first "|".
    const title = escapeSlack(link.title.trim() || link.url).replace(/\|/g, "∣");
    lines.push(`<${link.url.replace(/[<>|\s]/g, encodeURIComponent)}|${title}>`);
  }
  return { text: lines.filter(Boolean).join("\n") };
}
