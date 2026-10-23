import { CommentError } from "@/lib/comments";
import { PropertyValueError } from "@/lib/properties";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import { AgentError } from "@/server/agents/manage";
import { AiError } from "@/server/ai/errors";
import { ToolInputError, VersionConflictError } from "@/server/mcp/format";
import { GroupError } from "@/lib/groups";
import { TeamspaceError } from "@/lib/teamspace-error";
import { PAGE_LOCKED_MESSAGE } from "@/lib/page-lock";
import { PendingChangeError } from "@/server/pending-changes";
import { SequenceError } from "@/server/sequences/manage";
import { isPageSaveFailed } from "@/server/collab/bridge";

/** Every error code the REST API answers with, for the docs. */
export const API_ERROR_CODES = {
  unauthorized: { status: 401, description: "No token was sent: pass it as `Authorization: Bearer esi_…`." },
  invalid_token: { status: 401, description: "The token is malformed, unknown or revoked." },
  token_expired: { status: 401, description: "The token has expired; create a new one." },
  insufficient_scope: {
    status: 403,
    description: "The token lacks the scope this endpoint (or this use of it) needs; `details.scope` names it. Change what the token may do in Settings, keeping its secret.",
  },
  forbidden: {
    status: 403,
    description:
      "The user may see the page but not do this (for example comment on it), or the workspace lets connected apps and API tokens only read it.",
  },
  not_found: {
    status: 404,
    description: "The endpoint, or the page, database or row, doesn't exist or the token's user may not access it.",
  },
  method_not_allowed: { status: 405, description: "The endpoint doesn't take this HTTP method." },
  invalid_json: { status: 400, description: "The request body isn't a JSON object." },
  unsupported_media_type: {
    status: 415,
    description: "The body or the file it carries is of a kind the endpoint doesn't take (voice notes take multipart form data with an audio file).",
  },
  validation_error: {
    status: 400,
    description: "A parameter or body field is missing or invalid; `details` lists which, and `param` names the first.",
  },
  invalid_idempotency_key: { status: 400, description: "The Idempotency-Key header is empty or longer than 255 characters." },
  invalid_request: { status: 400, description: "The request can't be carried out as asked; the message says why." },
  invalid_property_value: {
    status: 400,
    description: "A row property value doesn't fit its property; `param` names it (`properties.Status`, or `rows.2.properties.Status` in a bulk call).",
  },
  invalid_cursor: { status: 400, description: "The pagination cursor is malformed." },
  agent_unavailable: { status: 409, description: "The agent can't run now: it is paused or archived, or AI is off for its workspace." },
  limit_reached: { status: 409, description: "The agent used its monthly token limit; it runs again next month, or once an owner raises the limit." },
  too_many_runs: { status: 409, description: "Too many runs asked of the agent are still waiting or under way; ask again once one has finished." },
  ai_unavailable: {
    status: 409,
    description: "AI can't be used: the server has no provider for what was asked, or the workspace turned AI off.",
  },
  voice_notes_unavailable: {
    status: 409,
    description: "Voice notes can't be made: the server has no speech to text set up, or the workspace turned AI off.",
  },
  follow_up_ended: { status: 409, description: "The follow-up has ended already, or isn't paused (resume)." },
  change_decided: { status: 409, description: "The change waiting for review was already approved, dismissed or expired." },
  change_conflict: {
    status: 409,
    description: "The row changed since the change was proposed, in a value it sets (`conflict: true`). Approve it again with `force: true` to overwrite, or dismiss it.",
  },
  version_conflict: {
    status: 409,
    description: "The page's body changed since `expected_version` was read, and nothing was written. Read the page again and make the change on its current body.",
  },
  idempotency_conflict: {
    status: 409,
    description: "A request with this Idempotency-Key is still running; send it again once that one has finished (Retry-After).",
  },
  idempotency_key_reused: {
    status: 422,
    description: "This Idempotency-Key was already used for a different request (another path, query or body) of the same operation; use a new key for each change.",
  },
  payload_too_large: { status: 413, description: "The request body is too large." },
  rate_limited: { status: 429, description: "Too many requests for this token; wait for Retry-After seconds." },
  internal_error: { status: 500, description: "Something went wrong on the server." },
  upstream_error: { status: 502, description: "The speech to text or AI provider failed or took too long; try again later." },
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

export class ApiError extends Error {
  /** Sent as Retry-After (a 429 for limits other than the token's own). */
  readonly retryAfterSeconds?: number;
  /** The request field it is about, where it is known: "title", "properties.Status". */
  readonly param?: string;

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    extra: { retryAfterSeconds?: number; param?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.param = extra.param;
  }
}

/** A 403 for a token without `scope`. */
export function insufficientScope(scope: string) {
  return new ApiError(403, "insufficient_scope", `This needs a token with the ${scope} scope.`, { scope });
}

/**
 * The field a property value error is about: `properties.<name>`, under `rows.<index>` when it
 * names a row of a bulk call.
 */
function propertyParam(error: PropertyValueError) {
  const { property, row } = error.params;
  if (!property) return undefined;
  return `${row !== undefined ? `rows.${row}.` : ""}properties.${property}`;
}

/** Maps domain errors to API errors; unknown errors stay opaque (and are logged). */
export function apiErrorFor(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // Writes to a workspace that lets apps only read: the user is in it, so saying why leaks nothing.
  if (error instanceof ConnectedAppReadOnlyError) return new ApiError(403, "forbidden", `${error.message}.`);
  // Missing and not allowed look the same, so ids never reveal what exists.
  if (error instanceof AccessError) return new ApiError(404, "not_found", "Not found or access denied");
  if (error instanceof VersionConflictError) {
    return new ApiError(409, "version_conflict", error.message, { expected_version: error.expected, version: error.current });
  }
  if (error instanceof ToolInputError) return new ApiError(400, "invalid_request", error.message);
  if (error instanceof PropertyValueError) return new ApiError(400, "invalid_property_value", error.message, undefined, { param: propertyParam(error) });
  if (error instanceof TeamspaceError) return new ApiError(403, "forbidden", error.message);
  if (error instanceof GroupError) return new ApiError(400, "invalid_request", error.message);
  // Locks guard against accidents rather than limit access: like operations' own refusals of a
  // locked page, they say what to do (lib/page-lock).
  const { code } = error as { code?: unknown };
  if (code === "pageLocked") return new ApiError(400, "invalid_request", PAGE_LOCKED_MESSAGE);
  if (code === "databaseLocked") {
    return new ApiError(
      400,
      "invalid_request",
      "The database is locked, so its properties and views can't change. Someone with full access can unlock it in the app.",
    );
  }
  if (error instanceof AgentError) {
    if (error.code === "notFound" || error.code === "notARow" || error.code === "notADatabase" || error.code === "scheduleNotFound") {
      return new ApiError(404, "not_found", `${error.message}.`);
    }
    // The agent is shared with the token's user, at a level that doesn't allow this.
    if (error.code === "notAllowed" || error.code === "ownersOnly") return new ApiError(403, "forbidden", `${error.message}.`);
    if (error.code === "archived" || error.code === "paused" || error.code === "aiOff") return new ApiError(409, "agent_unavailable", `${error.message}.`);
    if (error.code === "limitReached") return new ApiError(409, "limit_reached", `${error.message}.`);
    if (error.code === "tooManyRuns") return new ApiError(409, "too_many_runs", `${error.message}.`);
    return new ApiError(400, "invalid_request", `${error.message}.`);
  }
  if (error instanceof PendingChangeError) {
    if (error.code === "notFound") return new ApiError(404, "not_found", error.message);
    if (error.code === "decided") return new ApiError(409, "change_decided", error.message);
    if (error.code === "conflict") return new ApiError(409, "change_conflict", error.message);
    return new ApiError(400, "invalid_request", error.message);
  }
  if (error instanceof SequenceError) {
    if (error.code === "notFound") return new ApiError(404, "not_found", error.message);
    if (error.code === "noAccess" || error.code === "notSender") return new ApiError(403, "forbidden", error.message);
    if (error.code === "notOpen") return new ApiError(409, "follow_up_ended", error.message);
    return new ApiError(400, "invalid_request", error.message);
  }
  if (error instanceof AiError) return apiErrorForAi(error);
  // The collab service logged the database's refusal already; its text can name tables and constraints.
  if (isPageSaveFailed(error)) return new ApiError(500, "internal_error", "The page couldn't be saved, so this change isn't stored. Try again later.");
  if (error instanceof CommentError) {
    if (error.code === "notFound") return new ApiError(404, "not_found", error.message);
    if (error.code === "notAllowed") return new ApiError(403, "forbidden", error.message);
    return new ApiError(400, "invalid_request", error.message);
  }
  console.error("[api] request failed", error);
  return new ApiError(500, "internal_error", "Something went wrong on the server. Try again later.");
}

/**
 * Failures of the AI layer, in the API's terms. Endpoints with a more specific answer (voice notes'
 * voice_notes_unavailable) map "disabled" themselves. A provider's own error text stays in the
 * server log (the AI layer logs it): it can name the provider's setup or part of its key.
 */
function apiErrorForAi(error: AiError): ApiError {
  switch (error.code) {
    case "disabled":
      return new ApiError(409, "ai_unavailable", `${error.message}.`);
    case "noAccess":
      return new ApiError(404, "not_found", "Not found or access denied");
    case "tooLarge":
      return new ApiError(413, "payload_too_large", `${error.message}.`);
    case "rateLimited": {
      const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000));
      return new ApiError(429, "rate_limited", "Too many AI requests for this user or workspace; try again shortly.", undefined, { retryAfterSeconds: seconds });
    }
    case "invalid":
    case "empty":
      return new ApiError(400, "invalid_request", `${error.message}.`);
    case "timeout":
      return new ApiError(502, "upstream_error", "The speech to text or AI provider took too long to answer. Try again later.");
    default:
      return new ApiError(502, "upstream_error", "The speech to text or AI provider failed. Try again later.");
  }
}

export function errorBody(error: ApiError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.param !== undefined ? { param: error.param } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
