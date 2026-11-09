import { payloadOf } from "@/lib/slack-payload";
import { redactError } from "@/lib/redact";
import { BodyTooLargeError, readBodyLimited } from "@/server/request-body";
import { postFromWebhook } from "@/server/messages/webhooks";

/** A payload this big is not a chat message. */
const MAX_BODY = 512 * 1024;

const answer = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * A channel's webhook (server/messages/webhooks.ts): takes what a chat's incoming webhook takes,
 * as JSON or as a form's `payload` field, and answers as one does: `ok`, or what's wrong. No
 * session is read: the address's secret is all a sender has.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; secret: string }> }) {
  const { id, secret } = await params;
  let raw: string;
  try {
    raw = new TextDecoder().decode(await readBodyLimited(request, MAX_BODY));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return answer(413, "invalid_payload");
    throw error;
  }
  try {
    const result = await postFromWebhook(id, secret, payloadOf(request.headers.get("content-type") ?? "application/json", raw));
    return answer(result.status, result.text);
  } catch (error) {
    console.error("[messages] a webhook's post failed", redactError(error));
    return answer(500, "internal_error");
  }
}
