/**
 * Events as newline-delimited JSON, for a route the browser follows something through (an AI chat
 * answer, an agent's chat answer being written). `follow` gets a signal that aborts when the
 * browser goes; closing the response only stops following, not the work followed. Not to be
 * buffered on the way (`X-Accel-Buffering` for nginx) nor compressed (`no-transform`: a proxy that
 * compresses holds the events back until it has enough of them, and the answer comes in lumps).
 */
export function ndjsonResponse<T>(request: Request, follow: (signal: AbortSignal) => AsyncGenerator<T>, label: string) {
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
        if (!gone.signal.aborted) console.error(`[${label}] stream failed`, error);
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
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
