import * as z from "zod";
import { auth } from "@/lib/auth";
import { CHAT_MODES, CHAT_THINKING, type ChatEvent } from "@/lib/ai-chat";
import { CHAT_FILE_LIMITS } from "@/lib/chat-attachments";
import { AccessError } from "@/server/access";
import { aiErrorStatus, isAiError } from "@/server/ai";
import { startChat } from "@/server/ai-chat";
import { conversationBusy, dropRun, followRun, isRunId, openRun, runEvents } from "@/server/ai-chat-runs";
import { isCrossSite } from "@/server/cross-site";

export const dynamic = "force-dynamic";

/** Keeps an oversized body out; what a question may be is the model's to say (see startChat). */
const MAX_BODY_MESSAGE = 10_000_000;

const chatInput = z.object({
  // Picked by the browser, so Stop (stopChatAction) can name the answer before it has started.
  runId: z.string().refine(isRunId, "not a run id"),
  workspaceId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(100).nullish(),
  // Checked for length by startChat, which says so with its own error code.
  message: z.string().max(MAX_BODY_MESSAGE),
  // A page (and the pages under it) or a teamspace; checked by startChat.
  scope: z.union([z.object({ pageId: z.string().min(1).max(100) }).strict(), z.object({ teamspaceId: z.string().min(1).max(100) }).strict()]).nullish(),
  mode: z.enum(CHAT_MODES).optional(),
  replaceLast: z.boolean().optional(),
  skillId: z.string().min(1).max(100).nullish(),
  timeZone: z.string().max(100).nullish(),
  asSuggestions: z.boolean().optional(),
  model: z.string().min(1).max(200).nullish(),
  thinking: z.enum(CHAT_THINKING).nullish(),
  // Checked by startChat: the person's own files, not attached elsewhere.
  attachments: z.array(z.string().min(1).max(100)).max(CHAT_FILE_LIMITS.perQuestion).nullish(),
  research: z.boolean().optional(),
});

/**
 * The AI chat (#41): `POST /api/ai/chat` with `{runId, workspaceId, conversationId?, message, scope?, mode?,
 * replaceLast?, skillId?, timeZone?, model?, thinking?, attachments?, research?, asSuggestions?}` (`runId`:
 * the browser's id for the answer, unused before; `scope`:
 * `{pageId}` for a page and the pages under it, `{teamspaceId}` for a teamspace's pages; `replaceLast`:
 * ask again in place of the last question and answer; `skillId`: a skill whose instructions the
 * answer follows; `timeZone`: the browser's, for what today is; `model`: one the chat offers;
 * `thinking`: how much the model thinks (fast, balanced, deep);
 * `attachments`: ids of files from /api/ai/chat/files, which may stand without a question;
 * `research`: research mode; `asSuggestions`: what it writes in page bodies goes in as suggested edits).
 * Answers with newline-delimited JSON as the assistant works (see ChatEvent in lib/ai-chat.ts); in
 * mode `ask` the answer waits on each change for decideChangeAction.
 * Checks that fail before anything is sent answer with a status and `{"error":{"code","message"}}`;
 * a conversation still being answered takes no other question (409, `busy`).
 * The answer runs apart from the request (ai-chat-runs.ts): closing it, by reloading or closing
 * the page, leaves the answer going on to its end and saved; stopChatAction stops it, and
 * `GET /api/ai/chat?run=<runId>` follows it again from its start.
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

  const { runId, ...input } = parsed.data;
  const userId = session.user.id;
  if (input.conversationId && (await conversationBusy(userId, input.conversationId))) return fail("busy", "This conversation is still being answered", 409);
  const run = openRun({ id: runId, userId, workspaceId: input.workspaceId, conversationId: input.conversationId ?? null });
  if (!run) return fail("invalid", "That run id is taken", 409);
  let events;
  try {
    events = await startChat(userId, { ...input, scope: input.scope ?? null }, run.controller.signal);
  } catch (error) {
    dropRun(run);
    if (isAiError(error)) {
      const headers = error.retryAfterMs ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined;
      return fail(error.code, error.message, aiErrorStatus(error.code), headers);
    }
    if (error instanceof AccessError) return fail("noAccess", "Not found", 404);
    throw error;
  }
  // Runs to its end whether or not anyone follows it.
  void runEvents(run, events);
  return stream(request, (signal) => followRun(userId, runId, signal)!);
}

/**
 * Follows an answer of the person's on its way (`?run=<runId>`, from the conversation as
 * getConversation shows it): its events from the start, then as they come. 404 when it has ended
 * and gone (the conversation has it). Needs the `x-leafdesk-chat` header, which keeps other sites out.
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to use the AI chat", 401);
  if (isCrossSite(request, "x-leafdesk-chat")) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  const runId = new URL(request.url).searchParams.get("run");
  const userId = session.user.id;
  if (!isRunId(runId) || !followRun(userId, runId)) return fail("noAccess", "Not found", 404);
  return stream(request, (signal) => followRun(userId, runId, signal) ?? (async function* () {})());
}

/** The events as newline-delimited JSON; closing the response stops following, not the answer. */
function stream(request: Request, follow: (signal: AbortSignal) => AsyncGenerator<ChatEvent>) {
  const encoder = new TextEncoder();
  const gone = new AbortController();
  const events = follow(AbortSignal.any([request.signal, gone.signal]));
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          if (gone.signal.aborted) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        if (!gone.signal.aborted) console.error("[ai] chat stream failed", error);
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      gone.abort();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

function fail(code: string, message: string, status: number, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}
