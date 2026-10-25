import { fileIdOf, fileUrl } from "./files";

/**
 * Downloading what an image, video, audio or file block shows ("Download" in its block menu, the
 * file viewer's download button): an uploaded file from the file route as an attachment, a file on
 * another site through EXTERNAL_DOWNLOAD_ROUTE, which fetches it on the server (only public
 * addresses, see app/api/files/external/route.ts) so the browser saves it instead of opening it.
 * Pure, so both sides and tests can use it.
 */

export const EXTERNAL_DOWNLOAD_ROUTE = "/api/files/external";

/** The most an external download may be, in bytes. */
export const MAX_EXTERNAL_DOWNLOAD = 100 * 1024 * 1024;
/** How long an external download may take, start to end. */
export const EXTERNAL_DOWNLOAD_MS = 120_000;

/** An http(s) address without credentials, or null. */
function webAddress(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * The address that downloads what a block's `url` on page `pageId` points at, saved as `name` when
 * it has one; null when there is nothing to download (no URL, or one that is neither uploaded nor
 * on the web).
 */
export function downloadUrl(url: unknown, { pageId, name }: { pageId: string; name?: string }): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const id = fileIdOf(url);
  if (id) return `${fileUrl(id)}?download=1`;
  const web = webAddress(url.trim());
  if (!web) return null;
  const params = new URLSearchParams({ url: web.href, pageId });
  if (name?.trim()) params.set("name", name.trim());
  return `${EXTERNAL_DOWNLOAD_ROUTE}?${params}`;
}

/**
 * The name a download from `url` is saved as: the name given, else the last part of the address's
 * path, else "download". Without characters file systems refuse.
 */
export function downloadName(url: URL, name?: string | null): string {
  let base = name?.trim() ?? "";
  if (!base) {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      base = decodeURIComponent(last);
    } catch {
      base = last;
    }
  }
  const clean = base
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200);
  return clean || "download";
}
