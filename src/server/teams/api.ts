import { env } from "@/lib/env";
import { ChannelError, type ChannelErrorKind } from "@/server/chat-apps/transport";
import { trustedServiceUrl } from "./config";

/**
 * The few Bot Connector calls the Teams bot makes (Bot Connector REST API): sending, replacing and
 * typing activities in a conversation, at the conversation's own service address (which must be a
 * Microsoft bot service host, config.ts) with the bot's access token. The token comes from the
 * tenant's sign-in (client credentials, scope https://api.botframework.com/.default) and is kept
 * until shortly before it runs out; it goes to the service address and to nowhere else, redirects
 * are never followed, and neither it nor the secret is part of an error or a log line.
 */

export class TeamsApiError extends ChannelError {
  constructor(
    method: string,
    kind: ChannelErrorKind,
    /** Bot Framework's error code (`ConversationBlockedByUser`), or `http_<status>` / `network`. */
    readonly code: string,
    retryAfterMs?: number,
  ) {
    super("teams", method, kind, code, retryAfterMs);
    this.name = "TeamsApiError";
  }
}

/** Codes of a refusal that means nothing more can be sent to the chat. */
const GONE = new Set(["ConversationBlockedByUser", "BotNotInConversationRoster", "ConversationNotFound", "BotDisabledByAdmin"]);

function kindOf(method: string, status: number, code: string): ChannelErrorKind {
  if (GONE.has(code)) return "blocked";
  if (status === 401) return "unauthorized";
  if (status === 403) return "unauthorized";
  if (status === 404) return method === "update" ? "notFound" : "other";
  if (status === 429) return "rateLimited";
  if (status === 413) return "tooLarge";
  if (status === 400) return "badRequest";
  return "other";
}

// ---------------------------------------------------------------------------------- the token

let token: { value: string; expiresAt: number } | null = null;
let fetching: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const { teamsAppId, teamsAppPassword, teamsTenantId } = env;
  if (!teamsAppId || !teamsAppPassword || !teamsTenantId) throw new TeamsApiError("token", "unauthorized", "not_configured");
  let response: Response;
  try {
    response = await fetch(`${env.teamsLoginUrl}/${encodeURIComponent(teamsTenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: teamsAppId, client_secret: teamsAppPassword, scope: "https://api.botframework.com/.default" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TeamsApiError("token", "network", "network");
  }
  const answer = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!response.ok || typeof answer?.access_token !== "string") throw new TeamsApiError("token", response.status >= 500 ? "other" : "unauthorized", `http_${response.status}`);
  const seconds = typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : 3_600;
  token = { value: answer.access_token, expiresAt: Date.now() + Math.max(60, seconds - 300) * 1000 };
  return token.value;
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;
  fetching ??= fetchToken().finally(() => {
    fetching = null;
  });
  return fetching;
}

/** Tests: forgets the token held. */
export function resetTeamsToken() {
  token = null;
  fetching = null;
}

// ---------------------------------------------------------------------------------- calls

async function call<T>(method: string, serviceUrl: string, verb: "POST" | "PUT", path: string, body: unknown, retry = true): Promise<T | null> {
  const base = trustedServiceUrl(serviceUrl);
  if (!base) throw new TeamsApiError(method, "other", "untrusted_service_url");
  let response: Response;
  try {
    response = await fetch(`${base}v3/${path}`, {
      method: verb,
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof TeamsApiError) throw error;
    throw new TeamsApiError(method, "network", "network");
  }
  if (response.status === 401 && retry) {
    // The token may have been replaced meanwhile: one new one, once.
    resetTeamsToken();
    return call(method, serviceUrl, verb, path, body, false);
  }
  if (response.status >= 300 && response.status < 400) throw new TeamsApiError(method, "other", `http_${response.status}`);
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    const code = typeof failure?.error?.code === "string" ? failure.error.code : `http_${response.status}`;
    const seconds = Number(response.headers.get("retry-after"));
    throw new TeamsApiError(method, kindOf(method, response.status, code), code, response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1_000) : undefined);
  }
  return (await response.json().catch(() => null)) as T | null;
}

const conversationPath = (conversation: string) => `conversations/${encodeURIComponent(conversation)}/activities`;

/** An activity to send or replace, as the Connector takes it. */
export type OutgoingActivity = Record<string, unknown> & { type: "message" | "typing" };

/** Sends an activity into a conversation (as a reply to one of its activities when `replyTo` is given); the new activity's id. */
export async function sendActivity(serviceUrl: string, conversation: string, activity: OutgoingActivity, replyTo?: string): Promise<string> {
  const path = replyTo ? `${conversationPath(conversation)}/${encodeURIComponent(replyTo)}` : conversationPath(conversation);
  const answer = await call<{ id?: string }>("send", serviceUrl, "POST", path, replyTo ? { ...activity, replyToId: replyTo } : activity);
  return answer?.id ?? "";
}

/** Replaces an activity of the conversation. */
export async function updateActivity(serviceUrl: string, conversation: string, id: string, activity: OutgoingActivity): Promise<void> {
  await call("update", serviceUrl, "PUT", `${conversationPath(conversation)}/${encodeURIComponent(id)}`, { ...activity, id });
}
