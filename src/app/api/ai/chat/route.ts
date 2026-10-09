import * as z from "zod";
import { auth } from "@/lib/auth";
import { CHAT_MODES, MAX_CHAT_MESSAGE } from "@/lib/ai-chat";
import { AccessError } from "@/server/access";
import { aiErrorStatus, isAiError } from "@/server/ai";
import { startChat } from "@/server/ai-chat";
import { isCrossSite } from "@/server/cross-site";

const chatInput = z.object({
  workspaceId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(100).nullish(),
  // Checked for length by startChat, which says so with its own error code.
  message: z.string().max(MAX_CHAT_MESSAGE * 2),
  scope: z.object({ pageId: z.string().min(1).max(100) }).nullish(),
  mode: z.enum(CHAT_MODES).optional(),
  replaceLast: z.boolean().optional(),
});

/**
 * The AI chat (#41): `POST /api/ai/chat` with `{workspaceId, conversationId?, message, scope?, mode?,
 * replaceLast?}` (`replaceLast`: ask again in place of the last question and answer).
 * Answers with newline-delimited JSON as the assistant works (see ChatEvent in lib/ai-chat.ts); in
 * mode `ask` the answer waits on each change for decideChangeAction.
 * Checks that fail before anything is sent answer with a status and `{"error":{"code","message"}}`.
 * Closing the request cancels the model's work.
 *
 * Signed-in browsers only (the session cookie); a foreign Origin is refused, and the JSON body
 * needs a CORS preflight this route doesn't answer, which keeps cross-site pages out.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to use the AI chat", 401);
  if (isCrossSite(request)) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return fail("invalid", "Send JSON", 415);

  const parsed = chatInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);

  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let events;
  try {
    events = await startChat(session.user.id, { ...parsed.data, scope: parsed.data.scope ?? null }, signal);
  } catch (error) {
    if (isAiError(error)) {
      const headers = error.retryAfterMs ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined;
      return fail(error.code, error.message, aiErrorStatus(error.code), headers);
    }
    if (error instanceof AccessError) return fail("noAccess", "Not found", 404);
    throw error;
  }

  const encoder = new TextEncoder();
  // Once the browser has gone, the answer still runs to its end (to keep what it did) unsent.
  let gone = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) if (!gone) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch (error) {
        console.error("[ai] chat stream failed", error);
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: "provider" })}\n`));
        } catch {}
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      gone = true;
      cancel.abort();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

function fail(code: string, message: string, status: number, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}
