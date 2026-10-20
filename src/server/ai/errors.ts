import type { AiErrorCode } from "@/lib/ai";

/**
 * Why an AI request didn't give an answer. `message` is English for logs and API callers; the UI
 * shows its own text per code (messages `ai.errors.<code>`). Never carries prompt content.
 */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    /** For "rateLimited": how long until another request is allowed. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export const isAiError = (error: unknown): error is AiError => error instanceof AiError;

/** HTTP status for an error code, for route handlers. */
export function aiErrorStatus(code: AiErrorCode): number {
  switch (code) {
    case "disabled":
      return 403;
    case "noAccess":
      return 404;
    case "tooLarge":
      return 413;
    case "rateLimited":
      return 429;
    case "limitReached":
      return 402;
    case "timeout":
      return 504;
    case "aborted":
      return 499;
    case "invalid":
      return 400;
    default:
      return 502;
  }
}
