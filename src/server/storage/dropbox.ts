import type { Readable } from "node:stream";
import { assertKey, keyOf, objectIdOf, StorageError, type ObjectRef, type StorageDriver } from "./driver";
import { answerText, apiRequest, type OAuthSession } from "./oauth-session";
import { sendStream } from "./stream-upload";

/**
 * Someone's Dropbox, through an App folder app: Leafdesk reaches only Apps/<app name>, and keeps
 * each object at `/<key>` there. Objects are addressed by their Dropbox id (`id:…`, which `put`
 * returns) so moving the folder about doesn't lose them. A file up to 150 MiB is uploaded as one
 * streamed request; a larger one in an upload session, a chunk at a time.
 */

export type DropboxEndpoints = { api: string; content: string };
const DROPBOX: DropboxEndpoints = { api: "https://api.dropboxapi.com", content: "https://content.dropboxapi.com" };

/** The most one upload request may carry. */
const SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024;
/** What each request of an upload session carries (a multiple of 4 MiB, as Dropbox advises). */
const SESSION_CHUNK = 8 * 1024 * 1024;

export type DropboxConfig = {
  session: OAuthSession;
  endpoints?: Partial<DropboxEndpoints>;
  /** For tests: when uploads switch to sessions, and their chunk size. */
  singleUploadLimit?: number;
  sessionChunk?: number;
};

/** Dropbox puts the arguments of content requests in a header, which takes ASCII only. */
const apiArg = (value: unknown) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

type DropboxErrorBody = { error_summary?: string };

const summaryOf = (text: string) => {
  try {
    return (JSON.parse(text) as DropboxErrorBody).error_summary?.trim() || text.trim().slice(0, 300);
  } catch {
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  }
};

/** A 409 that says there is nothing at the path (download, delete). */
const notFound = (summary: string) => /(^|\/)not_found(\/|$|\.)/.test(summary);

function dropboxError(what: string, status: number, summary: string) {
  return new StorageError(`Dropbox ${what} failed: ${status}${summary ? ` ${summary}` : ""}`, status);
}

/** The signed-in Dropbox account: its id and address. */
export async function dropboxAccount(session: OAuthSession, endpoints: Partial<DropboxEndpoints> = {}): Promise<{ accountId: string; account: string }> {
  const api = endpoints.api ?? DROPBOX.api;
  const res = await apiRequest("Dropbox", () =>
    session.authorized((token) => fetch(`${api}/2/users/get_current_account`, { method: "POST", headers: { authorization: `Bearer ${token}` } })),
  );
  if (!res.ok) throw dropboxError("account lookup", res.status, summaryOf(await answerText(res)));
  const account = (await res.json()) as { account_id?: string; email?: string; name?: { display_name?: string } };
  if (!account.account_id) throw new StorageError("Dropbox didn't say which account this is", 502);
  return { accountId: account.account_id, account: account.email || account.name?.display_name || account.account_id };
}

/** Bytes from a stream in chunks of `size` (the last one shorter). */
async function* chunks(body: Readable, size: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let length = 0;
  for await (const piece of body) {
    let data = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    while (length + data.length >= size) {
      const take = size - length;
      held.push(data.subarray(0, take));
      yield Buffer.concat(held);
      held = [];
      length = 0;
      data = data.subarray(take);
    }
    if (data.length) {
      held.push(data);
      length += data.length;
    }
  }
  if (length) yield Buffer.concat(held);
}

export function dropboxDriver(config: DropboxConfig): StorageDriver {
  const api = config.endpoints?.api ?? DROPBOX.api;
  const content = config.endpoints?.content ?? DROPBOX.content;
  const singleLimit = config.singleUploadLimit ?? SINGLE_UPLOAD_LIMIT;
  const chunkSize = config.sessionChunk ?? SESSION_CHUNK;
  const { session } = config;

  const pathOf = (key: string) => {
    assertKey(key);
    return `/${key}`;
  };
  /** Where an object is: its id when kept, its path otherwise. */
  const placeOf = (ref: ObjectRef) => objectIdOf(ref) ?? pathOf(keyOf(ref));

  /** An upload session request with a chunk (or none) in its body. */
  const sessionCall = async (endpoint: string, arg: unknown, data: Buffer): Promise<Response> => {
    const res = await apiRequest("Dropbox upload", () =>
      session.authorized((token) =>
        fetch(`${content}/2/files/upload_session/${endpoint}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "dropbox-api-arg": apiArg(arg) },
          body: new Uint8Array(data),
        }),
      ),
    );
    if (!res.ok) throw dropboxError("upload", res.status, summaryOf(await answerText(res)));
    return res;
  };

  const commitOf = (key: string) => ({ path: pathOf(key), mode: "overwrite", autorename: false, mute: true });

  return {
    kind: "dropbox",

    async put(key, body, { size }) {
      const commit = commitOf(key);
      if (size <= singleLimit) {
        const token = await session.accessToken();
        const answer = await sendStream(
          new URL(`${content}/2/files/upload`),
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(size), "dropbox-api-arg": apiArg(commit) },
          },
          body,
          { what: "Dropbox upload" },
        );
        if (answer.status !== 200) throw dropboxError("upload", answer.status, summaryOf(answer.body));
        const id = (JSON.parse(answer.body) as { id?: string }).id;
        if (!id) throw new StorageError("Dropbox upload failed: no file id", 502);
        return id;
      }
      const started = await sessionCall("start", { close: false }, Buffer.alloc(0));
      const { session_id: sessionId } = (await started.json()) as { session_id: string };
      let offset = 0;
      for await (const chunk of chunks(body, chunkSize)) {
        await sessionCall("append_v2", { cursor: { session_id: sessionId, offset }, close: false }, chunk).then((res) => res.body?.cancel());
        offset += chunk.length;
      }
      if (offset !== size) throw new Error(`The upload was ${offset} bytes, not ${size}`);
      const finished = await sessionCall("finish", { cursor: { session_id: sessionId, offset }, commit }, Buffer.alloc(0));
      const id = ((await finished.json()) as { id?: string }).id;
      if (!id) throw new StorageError("Dropbox upload failed: no file id", 502);
      return id;
    },

    async get(ref, range) {
      const place = placeOf(ref);
      const res = await apiRequest("Dropbox download", () =>
        session.authorized((token) =>
          fetch(`${content}/2/files/download`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "dropbox-api-arg": apiArg({ path: place }), ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}) },
          }),
        ),
      );
      if (res.ok) return res.body;
      const summary = summaryOf(await answerText(res));
      if (res.status === 409 && notFound(summary)) return null;
      throw dropboxError("download", res.status, summary);
    },

    async delete(ref) {
      const place = placeOf(ref);
      const res = await apiRequest("Dropbox delete", () =>
        session.authorized((token) =>
          fetch(`${api}/2/files/delete_v2`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ path: place }),
          }),
        ),
      );
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      const summary = summaryOf(await answerText(res));
      // Already gone is what was wanted.
      if (res.status === 409 && notFound(summary)) return;
      throw dropboxError("delete", res.status, summary);
    },
  };
}
