/**
 * What a chat's incoming webhook is sent, as a message body (server/messages/webhooks.ts): the
 * payload tools such as alert managers, dashboards and build pipelines post. Its `text` is Slack's
 * mrkdwn; legacy `attachments` (cards with a title, text, fields and a footer) and Block Kit
 * `blocks` (headers, sections, fields, context, dividers, images, rich text, link buttons) become
 * Markdown under or in place of it. Buttons and menus that only a chat app could answer are left
 * out, and so are images from other sites, which become links: a message never loads an address a
 * payload gives.
 *
 * Pure. Payloads come from anyone holding a webhook's address: lengths are capped and nothing here
 * retries a pattern against what follows (the mrkdwn reader is the Slack importer's).
 */
import { slackBody, type SlackNames } from "@/lib/import/slack";

/** Why a payload is refused, in the words a chat's webhook answers with. */
export type SlackPayloadError = "invalid_payload" | "no_text";

export type SlackPayloadResult = { ok: true; body: string } | { ok: false; error: SlackPayloadError };

/** Characters of the body made; the rest is cut. */
export const WEBHOOK_BODY_LIMIT = 40_000;
/** Blocks, attachments and fields read at most. */
const MAX_ITEMS = 50;

/** People and channels of another workspace mean nothing here: they show as what the payload named. */
const NAMES: SlackNames = { user: (id) => ({ userId: null, name: id }), channel: () => null };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 3000) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const SAFE_LINK = /^https?:\/\//i;

/** Mrkdwn as Markdown. */
const mrkdwn = (text: string) => slackBody(text, NAMES).trim();
/** Plain text, with Markdown's marks kept as written characters. */
const escaped = (text: string) => text.replace(/([\\`*_~[\]#<>|])/g, "\\$1");
const plain = (text: string) => escaped(text).trim();

/** A text object (`{ type: "mrkdwn" | "plain_text", text }`) as Markdown. */
function textObject(v: unknown): string {
  if (!isObject(v)) return "";
  const text = str(v.text);
  return v.type === "mrkdwn" ? mrkdwn(text) : plain(text);
}

/** A link, when `url` is a web address; otherwise the label alone. */
function link(label: string, url: unknown): string {
  const href = str(url, 2048);
  if (!SAFE_LINK.test(href)) return label;
  return `[${label.replace(/[[\]\\]/g, "") || href}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
}

/** Rich text's elements (`rich_text_section`, lists, quotes, preformatted) as Markdown. */
function richText(elements: unknown[]): string {
  const inline = (els: unknown[]) =>
    els
      .map((e) => {
        if (!isObject(e)) return "";
        if (e.type === "text") {
          let t = escaped(str(e.text));
          const style = isObject(e.style) ? e.style : {};
          if (style.code) t = `\`${str(e.text).replace(/`/g, "")}\``;
          if (style.bold) t = `**${t}**`;
          if (style.italic) t = `_${t}_`;
          if (style.strike) t = `~~${t}~~`;
          return t;
        }
        if (e.type === "link") return link(plain(str(e.text)) || str(e.url), e.url);
        if (e.type === "emoji") return typeof e.unicode === "string" ? String.fromCodePoint(...e.unicode.split("-").map((h) => parseInt(h, 16)).filter((n) => Number.isFinite(n) && n > 0 && n <= 0x10ffff)) : `:${str(e.name, 64)}:`;
        if (e.type === "user") return `@${str(e.user_id, 64)}`;
        if (e.type === "channel") return `#${str(e.channel_id, 64)}`;
        if (e.type === "broadcast") return `@${str(e.range, 16)}`;
        return "";
      })
      .join("");
  return elements
    .map((el) => {
      if (!isObject(el)) return "";
      const children = list(el.elements);
      if (el.type === "rich_text_section") return inline(children);
      if (el.type === "rich_text_preformatted") return "```\n" + children.map((c) => (isObject(c) ? str(c.text) : "")).join("").replace(/```/g, "ˋˋˋ") + "\n```";
      if (el.type === "rich_text_quote") return inline(children).split("\n").map((l) => `> ${l}`).join("\n");
      if (el.type === "rich_text_list") {
        const ordered = el.style === "ordered";
        return children.map((item, i) => `${ordered ? `${i + 1}.` : "-"} ${isObject(item) ? inline(list(item.elements)) : ""}`).join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** One Block Kit block as Markdown ("" for what can't be shown). */
function block(b: unknown): string {
  if (!isObject(b)) return "";
  switch (b.type) {
    case "header":
      return `### ${textObject(b.text)}`;
    case "section": {
      const parts = [textObject(b.text)];
      const fields = list(b.fields).map(textObject).filter(Boolean);
      if (fields.length) parts.push(fields.map((f) => `- ${f.replace(/\n/g, " ")}`).join("\n"));
      if (isObject(b.accessory) && b.accessory.type === "button" && b.accessory.url) parts.push(link(textObject(b.accessory.text), b.accessory.url));
      return parts.filter(Boolean).join("\n\n");
    }
    case "markdown":
      return str(b.text, 12_000).trim();
    case "context":
      return list(b.elements)
        .map((e) => (isObject(e) && e.type === "image" ? "" : textObject(e)))
        .filter(Boolean)
        .join(" · ");
    case "divider":
      return "---";
    case "image": {
      const alt = plain(str(b.alt_text, 300)) || textObject(b.title) || "image";
      return link(alt, b.image_url);
    }
    case "rich_text":
      return richText(list(b.elements));
    case "actions":
      return list(b.elements)
        .filter((e): e is Json => isObject(e) && e.type === "button" && typeof e.url === "string")
        .map((e) => link(textObject(e.text), e.url))
        .join(" · ");
    default:
      return "";
  }
}

/** A legacy attachment: its pretext, author, linked title, text, fields, image link and footer. */
function attachment(a: unknown): string {
  if (!isObject(a)) return "";
  const lines: string[] = [];
  const pretext = mrkdwn(str(a.pretext));
  const inner: string[] = [];
  const author = plain(str(a.author_name, 300));
  if (author) inner.push(a.author_link ? link(author, a.author_link) : author);
  const title = plain(str(a.title, 500));
  if (title) inner.push(`**${a.title_link ? link(title, a.title_link) : title}**`);
  const text = mrkdwn(str(a.text));
  if (text) inner.push(text);
  for (const f of list(a.fields)) {
    if (!isObject(f)) continue;
    const name = plain(str(f.title, 300));
    const value = mrkdwn(str(f.value, 2000)).replace(/\n/g, " ");
    if (name || value) inner.push(name ? `**${name}**: ${value}` : value);
  }
  if (a.image_url) inner.push(link(plain(str(a.fallback, 300)) || "image", a.image_url));
  const footer = plain(str(a.footer, 300));
  const ts = typeof a.ts === "number" ? new Date(a.ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  if (footer || ts) inner.push(`_${[footer, ts].filter(Boolean).join(" · ")}_`);
  if (!inner.length && !pretext) {
    const fallback = mrkdwn(str(a.fallback));
    return fallback;
  }
  if (pretext) lines.push(pretext);
  if (inner.length) lines.push(inner.join("\n").split("\n").map((l) => `> ${l}`).join("\n"));
  return lines.join("\n\n");
}

/**
 * The body a payload makes: its blocks in place of its text when any of them shows (the text is
 * their fallback, as in chat apps), else its text; attachments under either.
 */
export function slackPayloadBody(payload: unknown): SlackPayloadResult {
  if (!isObject(payload)) return { ok: false, error: "invalid_payload" };
  const blocks = list(payload.blocks).map(block).filter(Boolean);
  const text = mrkdwn(str(payload.text, WEBHOOK_BODY_LIMIT));
  const attachments = list(payload.attachments).map(attachment).filter(Boolean);
  const head = blocks.length ? blocks.join("\n\n") : text;
  const body = [head, ...attachments].filter(Boolean).join("\n\n").trim();
  if (!body) return { ok: false, error: "no_text" };
  return { ok: true, body: body.length > WEBHOOK_BODY_LIMIT ? `${body.slice(0, WEBHOOK_BODY_LIMIT - 1)}…` : body };
}

/** The payload of a request's body: JSON, or a form's `payload` field holding JSON. */
export function payloadOf(contentType: string, raw: string): unknown {
  const type = contentType.split(";")[0].trim().toLowerCase();
  try {
    if (type === "application/x-www-form-urlencoded") {
      const field = new URLSearchParams(raw).get("payload");
      return field === null ? null : JSON.parse(field);
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
