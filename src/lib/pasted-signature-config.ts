import type { Config } from "dompurify";

/**
 * What a pasted signature keeps: anything a mail shows, with its inline styles, but nothing that
 * runs, no forms or frames, no style sheets (they would reach the whole message) and images only
 * from the web or carried in it.
 */
export const PASTED_SIGNATURE_CONFIG: Config = {
  FORBID_TAGS: ["style", "title", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta", "iframe", "frame", "frameset", "object", "embed", "applet", "audio", "video", "source", "track", "portal", "math", "svg"],
  FORBID_ATTR: ["id", "class", "srcset", "ping", "action", "formaction", "poster", "lowsrc", "dynsrc"],
  ALLOW_DATA_ATTR: false,
  // As server/mail-client/html.ts: values that name no scheme (a width, `center`, `#fff`) pass.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpe?g|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};
