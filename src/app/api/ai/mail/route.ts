import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { aiErrorStatus, isAiError } from "@/server/ai";
import { answerStream, refuse } from "@/server/ai-answer-stream";
import { isCrossSite } from "@/server/cross-site";
import { mailAiInput, startMailAi } from "@/server/mail-client/ai";
import { RowMailError } from "@/server/row-mail/settings";

/**
 * The Mail tab's AI: `POST /api/ai/mail` with `{"kind":"summary",…}` or `{"kind":"write",…}`
 * (server/mail-client/ai.ts) as JSON. Answers as `/api/ai/write` does (server/ai-answer-stream.ts);
 * mail that can't be read answers 502 with the code "mail". Signed-in browsers only, the mailbox's
 * owner alone; a foreign Origin is refused.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return refuse("noAccess", "Sign in to use the AI assistant", 401);
  if (isCrossSite(request)) return refuse("noAccess", "Cross-site requests aren't allowed", 403);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return refuse("invalid", "Send JSON", 415);

  const parsed = mailAiInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);

  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let started;
  try {
    started = await startMailAi(session.user.id, parsed.data, signal);
  } catch (error) {
    if (isAiError(error)) {
      const headers = error.retryAfterMs ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined;
      return refuse(error.code, error.message, aiErrorStatus(error.code), headers);
    }
    if (error instanceof AccessError) return refuse("noAccess", "Mailbox not found", 404);
    if (error instanceof RowMailError) {
      if (error.code === "noMailbox" || error.code === "disabled") return refuse("noAccess", "Mailbox not found", 404);
      return refuse("mail", error.message, 502);
    }
    throw error;
  }
  return answerStream(started.answer, cancel, started.finished);
}
