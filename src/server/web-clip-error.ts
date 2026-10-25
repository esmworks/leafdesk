/** Why a web page couldn't be saved (server/web-clip.ts); the app and the API say it in their own words. */
export const WEB_CLIP_ERROR_CODES = ["invalidUrl", "blocked", "unreachable", "timeout", "httpError", "notHtml", "noAccess", "badTarget", "tooComplex"] as const;
export type WebClipErrorCode = (typeof WEB_CLIP_ERROR_CODES)[number];

export class WebClipError extends Error {
  constructor(
    readonly code: WebClipErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebClipError";
  }
}
