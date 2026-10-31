import { isAiError, type AiStream } from "@/server/ai";

/**
 * A model's answer streamed to the browser as newline-delimited JSON (components/ai-stream.ts reads
 * it): `{"type":"text","text":"…"}` lines as it writes, then `{"type":"done","stopReason":"stop"|"length"}`
 * or `{"type":"error","code":"…"}`. `finished` gets the whole text of an answer that ended on its own
 * before "done" goes out. Closing the request cancels the model's work through `cancel`.
 */
export function answerStream(answer: AiStream, cancel: AbortController, finished?: (text: string) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = "";
      try {
        for await (const event of answer) {
          if (event.type !== "text") continue;
          text += event.delta;
          controller.enqueue(line({ type: "text", text: event.delta }));
        }
        const result = await answer.result();
        if (finished && result.stopReason === "stop") await finished(text).catch((error) => console.error("[ai] keeping an answer failed", error));
        controller.enqueue(line({ type: "done", stopReason: result.stopReason }));
      } catch (error) {
        controller.enqueue(line({ type: "error", code: isAiError(error) ? error.code : "provider" }));
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      cancel.abort();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

/** A request refused before the model was asked: `{"error":{"code","message"}}` with its status. */
export function refuse(code: string, message: string, status: number, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}
