import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { aiErrorStatus, isAiError } from "@/server/ai";
import { answerStream, refuse as fail } from "@/server/ai-answer-stream";
import { editorActionInput, startEditorAction } from "@/server/ai-writing";
import { isCrossSite } from "@/server/cross-site";

/**
 * The editor's AI writing assistant: `POST /api/ai/write` with an action (see ai-writing.ts) as
 * JSON. Answers with newline-delimited JSON as the model writes (server/ai-answer-stream.ts). Checks
 * that fail before anything is sent answer with a status and `{"error":{"code","message"}}`. Closing
 * the request cancels the model's work.
 *
 * Signed-in browsers only (the session cookie); a foreign Origin is refused, and the JSON body
 * needs a CORS preflight this route doesn't answer, which keeps cross-site pages out.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to use the AI assistant", 401);
  if (isCrossSite(request)) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return fail("invalid", "Send JSON", 415);

  const parsed = editorActionInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);

  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let answer;
  try {
    answer = await startEditorAction(session.user.id, parsed.data, signal);
  } catch (error) {
    if (isAiError(error)) {
      const headers = error.retryAfterMs ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined;
      return fail(error.code, error.message, aiErrorStatus(error.code), headers);
    }
    if (error instanceof AccessError) return fail("noAccess", "Page not found", 404);
    throw error;
  }
  return answerStream(answer, cancel);
}
