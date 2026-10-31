/**
 * Reads an AI answer streamed by one of the `/api/ai/*` routes (server/ai-answer-stream.ts), handing
 * each piece of text to `onText` as it comes. Resolves with how it ended, or with the error code of a
 * request refused or failed ("provider" when the answer broke off). Throws only when `signal` aborts.
 */
export async function streamAi(
  url: string,
  body: unknown,
  { signal, onText }: { signal: AbortSignal; onText: (text: string) => void },
): Promise<{ ok: true; stopReason: string } | { ok: false; code: string | undefined }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { ok: false, code: error?.error?.code };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let stopReason: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: string; text?: string; code?: string; stopReason?: string };
      if (event.type === "text" && event.text) onText(event.text);
      else if (event.type === "error") return { ok: false, code: event.code };
      else if (event.type === "done") stopReason = event.stopReason ?? "stop";
    }
  }
  return stopReason ? { ok: true, stopReason } : { ok: false, code: "provider" };
}
