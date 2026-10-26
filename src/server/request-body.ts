/**
 * Request bodies (and answers to the server's own requests) read with a size limit that holds
 * while they stream in: a declared Content-Length over it is refused before anything is read, and
 * a body sent without one (chunked) stops being read one chunk past the limit, so a large upload
 * never sits whole in memory.
 */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The request body is larger than ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** The body's bytes, at most `maxBytes` of them. Throws BodyTooLargeError beyond that. */
export async function readBodyLimited(request: Pick<Request, "headers" | "body">, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A multipart (or URL-encoded) body as form data, at most `maxBytes` of it. Throws
 * BodyTooLargeError beyond that, and TypeError when the body isn't valid form data.
 */
export async function readFormLimited(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBodyLimited(request, maxBytes);
  return new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}
