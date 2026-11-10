import { env } from "@/lib/env";
import { ChannelError, type ChannelErrorKind } from "@/server/chat-apps/transport";

/**
 * The few Slack Web API methods the Slack bot uses (https://api.slack.com/methods), over
 * SLACK_API_URL: with the bot's token (xoxb-), and `apps.connections.open` with the app's
 * (xapp-, Socket Mode). Every call is a form post, which every method takes (objects and lists
 * as JSON). Errors come back as SlackApiError with Slack's own error code; a token is never part
 * of an error or a log line.
 */

export class SlackApiError extends ChannelError {
  constructor(
    method: string,
    /** Slack's `error` (`channel_not_found`), or `http_<status>` / `network`. */
    readonly code: string,
    retryAfterMs?: number,
  ) {
    super("slack", method, kindOf(code), code, retryAfterMs);
    this.name = "SlackApiError";
  }
}

const BLOCKED = new Set(["channel_not_found", "is_archived", "user_not_found", "user_disabled", "cannot_dm_bot", "messages_tab_disabled", "not_in_channel"]);
const UNAUTHORIZED = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope"]);

function kindOf(code: string): ChannelErrorKind {
  if (UNAUTHORIZED.has(code)) return "unauthorized";
  if (BLOCKED.has(code)) return "blocked";
  if (code === "ratelimited" || code === "http_429") return "rateLimited";
  if (code === "message_not_found" || code === "cant_update_message" || code === "file_not_found" || code === "http_404") return "notFound";
  if (code === "too_large" || code === "file_too_large") return "tooLarge";
  if (code === "network") return "network";
  if (/^(invalid_|msg_too_long|no_text|too_many_attachments)/.test(code)) return "badRequest";
  return "other";
}

export type SlackUser = { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string }; is_bot?: boolean; locale?: string };
export type SlackFile = { id: string; name?: string; title?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string; duration_ms?: number; subtype?: string };

/** The Slack origins a token may be sent to: Slack's own file host, and the API's (a fake one in tests). */
export function tokenOrigins(): Set<string> {
  return new Set(["https://files.slack.com", new URL(env.slackApiUrl).origin]);
}

/** Calls a Web API method; its answer, or SlackApiError. `token` "app" uses the app-level token. */
export async function callSlack<T extends Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, token: "bot" | "app" = "bot"): Promise<T & { ok: true }> {
  const secret = token === "app" ? env.slackAppToken : env.slackBotToken;
  if (!secret) throw new SlackApiError(method, "not_authed");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  let response: Response;
  try {
    response = await fetch(`${env.slackApiUrl}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SlackApiError(method, "network");
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SlackApiError(method, "ratelimited", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000);
  }
  const answer = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
  if (!answer?.ok) throw new SlackApiError(method, answer?.error ?? `http_${response.status}`);
  return answer as T & { ok: true };
}

/** Downloads a file a message carries (`url_private_download`), at most `maxBytes` of it; the token goes only to Slack's own hosts. */
export async function downloadSlackFile(url: string, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SlackApiError("files.download", "file_not_found");
  }
  if (!tokenOrigins().has(parsed.origin)) throw new SlackApiError("files.download", "file_not_found");
  let response: Response;
  try {
    response = await fetch(parsed, {
      headers: { Authorization: `Bearer ${env.slackBotToken ?? ""}` },
      // Another host never gets the token: a redirect is followed only by hand, without it.
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SlackApiError("files.download", "network");
  }
  if (!response.ok) throw new SlackApiError("files.download", `http_${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new SlackApiError("files.download", "too_large");
  const blob = await response.blob();
  if (blob.size > maxBytes) throw new SlackApiError("files.download", "too_large");
  return blob;
}

/** Uploads a file into a chat, with a comment (files.getUploadURLExternal, then files.completeUploadExternal). */
export async function uploadSlackFile(channel: string, file: { name: string; contentType: string; bytes: Uint8Array }, comment?: string) {
  const { upload_url: uploadUrl, file_id: fileId } = await callSlack<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
    filename: file.name,
    length: String(file.bytes.length),
  });
  let response: Response;
  try {
    response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.contentType || "application/octet-stream" }, body: new Uint8Array(file.bytes), signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new SlackApiError("files.upload", "network");
  }
  if (!response.ok) throw new SlackApiError("files.upload", `http_${response.status}`);
  await callSlack("files.completeUploadExternal", { files: [{ id: fileId, title: file.name }], channel_id: channel, ...(comment ? { initial_comment: comment.slice(0, 1_000) } : {}) });
}
