import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { StorageError } from "./driver";

export type StreamAnswer = { status: number; headers: IncomingHttpHeaders; body: string };

/** The most of an answer kept: enough for an error message or a small JSON result. */
const ANSWER_LIMIT = 64 * 1024;

/**
 * Sends `body` as a request's body with the given headers (a Content-Length among them) and
 * resolves with the answer, whatever its status. Node's http client, not fetch: storage services
 * want a Content-Length on uploads (some refuse chunked bodies), which fetch won't set for a
 * stream, so a file is never held in memory to get one.
 *
 * Rejects with a StorageError (`<what> failed: …`, no status) when the request couldn't be made,
 * and with the body's own error when the body failed (a file that couldn't be read is no fault of
 * the storage's).
 */
export function sendStream(
  url: URL,
  init: { method: string; headers: Record<string, string> },
  body: Readable,
  options: Pick<RequestOptions, "agent" | "lookup"> & { what: string; timeoutMs?: number },
): Promise<StreamAnswer> {
  const { what, timeoutMs = 5 * 60 * 1000, ...connect } = options;
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: init.method, headers: init.headers, ...connect }, (res) => {
      const chunks: Buffer[] = [];
      let length = 0;
      res.on("data", (chunk: Buffer) => {
        if (length < ANSWER_LIMIT) {
          chunks.push(chunk);
          length += chunk.length;
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8").slice(0, ANSWER_LIMIT) }));
      res.on("error", reject);
    });
    let bodyError: Error | null = null;
    req.setTimeout(timeoutMs, () => req.destroy(new StorageError(`${what} timed out`)));
    req.on("error", (error) => {
      if (bodyError || error instanceof StorageError) reject(bodyError ?? error);
      else reject(new StorageError(`${what} failed: ${error.message}`, null, { cause: error }));
    });
    body.on("error", (error) => {
      bodyError = error;
      req.destroy(error);
    });
    body.pipe(req);
  });
}
