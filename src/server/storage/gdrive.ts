import type { Readable } from "node:stream";
import { assertKey, keyOf, objectIdOf, StorageError, type ObjectRef, type StorageDriver } from "./driver";
import { answerText, apiRequest, type OAuthSession } from "./oauth-session";
import { sendStream } from "./stream-upload";

/**
 * A folder in someone's Google Drive, reached with the `drive.file` scope: Leafdesk sees and
 * changes only the files and folders it made itself. Each object is a Drive file in the folder,
 * named after its key (kept in its appProperties too) and addressed by its Drive id, which `put`
 * returns. Uploads are resumable uploads sent as one streamed request with a known length.
 */

export type GDriveEndpoints = { api: string; upload: string };
const DRIVE: GDriveEndpoints = { api: "https://www.googleapis.com", upload: "https://www.googleapis.com" };

const FOLDER_TYPE = "application/vnd.google-apps.folder";

/** Drive says "slow down" with a 403 and a reason as often as with a 429. */
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

type DriveErrorBody = { error?: { code?: number; message?: string; errors?: { reason?: string }[] } };

function parseError(text: string): { reason?: string; message?: string } {
  try {
    const body = JSON.parse(text) as DriveErrorBody;
    return { reason: body.error?.errors?.[0]?.reason, message: body.error?.message };
  } catch {
    return { message: text.replace(/\s+/g, " ").trim().slice(0, 300) || undefined };
  }
}

/** A refused request as a StorageError: a rate limit as a 429, so it counts as passing. */
function driveError(what: string, status: number, text: string) {
  const { reason, message } = parseError(text);
  const said = [reason, message].filter(Boolean).join(": ");
  return new StorageError(`Google Drive ${what} failed: ${status}${said ? ` ${said}` : ""}`, status === 403 && reason && RATE_REASONS.has(reason) ? 429 : status);
}

async function failure(what: string, res: Response) {
  return driveError(what, res.status, await answerText(res));
}

/** Worth trying again (a 403 "slow down" isn't seen until its body is read: it counts as passing). */
const busy = (res: Response) => res.status >= 500 || res.status === 429;

/** The Drive file name for a key: one name, no folders. */
const nameOf = (key: string) => key.replaceAll("/", "_");

/** Names put in a Drive search must stay inside its quotes. */
const quoted = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export type GDriveConfig = { folderId: string; session: OAuthSession; endpoints?: Partial<GDriveEndpoints> };

/** The signed-in Drive account: its stable id and address. */
export async function driveAccount(session: OAuthSession, endpoints: Partial<GDriveEndpoints> = {}): Promise<{ accountId: string; account: string }> {
  const api = endpoints.api ?? DRIVE.api;
  const res = await apiRequest("Google Drive", () =>
    session.authorized((token) => fetch(`${api}/drive/v3/about?fields=${encodeURIComponent("user(permissionId,emailAddress,displayName)")}`, { headers: { authorization: `Bearer ${token}` } })),
  );
  if (!res.ok) throw await failure("account lookup", res);
  const { user } = (await res.json()) as { user?: { permissionId?: string; emailAddress?: string; displayName?: string } };
  if (!user?.permissionId) throw new StorageError("Google Drive didn't say which account this is", 502);
  return { accountId: user.permissionId, account: user.emailAddress || user.displayName || user.permissionId };
}

/**
 * The folder the workspace's files go in: the one Leafdesk made for it in this Drive before (found
 * by its appProperties, so signing in again keeps it), or a new one named `name`.
 */
export async function driveFolder(
  session: OAuthSession,
  workspaceId: string,
  name: string,
  endpoints: Partial<GDriveEndpoints> = {},
): Promise<{ folderId: string; folderName: string }> {
  const api = endpoints.api ?? DRIVE.api;
  const q = `mimeType=${quoted(FOLDER_TYPE)} and trashed=false and appProperties has { key='leafdeskWorkspace' and value=${quoted(workspaceId)} }`;
  const found = await apiRequest("Google Drive", () =>
    session.authorized((token) =>
      fetch(`${api}/drive/v3/files?${new URLSearchParams({ q, spaces: "drive", fields: "files(id,name)", pageSize: "1" })}`, { headers: { authorization: `Bearer ${token}` } }),
    ),
  );
  if (!found.ok) throw await failure("folder lookup", found);
  const [existing] = ((await found.json()) as { files?: { id: string; name: string }[] }).files ?? [];
  if (existing) return { folderId: existing.id, folderName: existing.name };
  const made = await apiRequest("Google Drive", () =>
    session.authorized((token) =>
      fetch(`${api}/drive/v3/files?fields=id,name`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER_TYPE, appProperties: { leafdeskWorkspace: workspaceId } }),
      }),
    ),
  );
  if (!made.ok) throw await failure("folder creation", made);
  const folder = (await made.json()) as { id: string; name: string };
  return { folderId: folder.id, folderName: folder.name };
}

export function gdriveDriver(config: GDriveConfig): StorageDriver {
  const api = config.endpoints?.api ?? DRIVE.api;
  const upload = config.endpoints?.upload ?? DRIVE.upload;
  const { session } = config;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** The Drive id of a ref: the one kept for it, or the file in the folder named after its key. */
  const idOf = async (ref: ObjectRef): Promise<string | null> => {
    const known = objectIdOf(ref);
    if (known) return known;
    const key = keyOf(ref);
    assertKey(key);
    const q = `${quoted(config.folderId)} in parents and trashed=false and appProperties has { key='leafdeskKey' and value=${quoted(key)} }`;
    const res = await apiRequest("Google Drive", () =>
      session.authorized((token) => fetch(`${api}/drive/v3/files?${new URLSearchParams({ q, spaces: "drive", fields: "files(id)", pageSize: "1" })}`, { headers: bearer(token) })),
      busy,
    );
    if (!res.ok) throw await failure("lookup", res);
    return ((await res.json()) as { files?: { id: string }[] }).files?.[0]?.id ?? null;
  };

  return {
    kind: "gdrive",

    async put(key: string, body: Readable, { size, contentType }) {
      assertKey(key);
      // Begin a resumable upload: Drive answers with the address to send the bytes to.
      const begun = await apiRequest(
        "Google Drive upload",
        () =>
          session.authorized((token) =>
            fetch(`${upload}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
              method: "POST",
              headers: {
                ...bearer(token),
                "content-type": "application/json; charset=UTF-8",
                "x-upload-content-type": contentType,
                "x-upload-content-length": String(size),
              },
              body: JSON.stringify({ name: nameOf(key), parents: [config.folderId], mimeType: contentType, appProperties: { leafdeskKey: key } }),
              redirect: "error",
            }),
          ),
        busy,
      );
      if (!begun.ok) throw await failure("upload", begun);
      await begun.body?.cancel().catch(() => undefined);
      const location = begun.headers.get("location");
      let target: URL;
      try {
        target = new URL(location ?? "");
      } catch {
        throw new StorageError("Google Drive upload failed: no upload address", 502);
      }
      // The one address not written here: it must be Drive's own.
      if (target.origin !== new URL(upload).origin) throw new StorageError(`Google Drive upload failed: unexpected upload address ${target.host}`, 502);
      const token = await session.accessToken();
      const answer = await sendStream(
        target,
        { method: "PUT", headers: { ...bearer(token), "content-type": contentType, "content-length": String(size) } },
        body,
        { what: "Google Drive upload" },
      );
      if (answer.status !== 200 && answer.status !== 201) throw driveError("upload", answer.status, answer.body);
      const id = (JSON.parse(answer.body) as { id?: string }).id;
      if (!id) throw new StorageError("Google Drive upload failed: no file id", 502);
      return id;
    },

    async get(ref, range) {
      const id = await idOf(ref);
      if (!id) return null;
      const res = await apiRequest(
        "Google Drive download",
        () =>
          session.authorized((token) =>
            fetch(`${api}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
              headers: { ...bearer(token), ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}) },
            }),
          ),
        busy,
      );
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok) throw await failure("download", res);
      return res.body;
    },

    async delete(ref) {
      const id = await idOf(ref);
      if (!id) return;
      const res = await apiRequest(
        "Google Drive delete",
        () => session.authorized((token) => fetch(`${api}/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: bearer(token) })),
        busy,
      );
      if (!res.ok && res.status !== 404) throw await failure("delete", res);
      await res.body?.cancel().catch(() => undefined);
    },
  };
}
