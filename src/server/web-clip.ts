import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { WarningList, type ImportResult } from "@/lib/import/result";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { knownProperties } from "@/server/databases";
import { recordImport } from "@/server/import/csv";
import { htmlBlocks, imageName, imageSources, isPageImage, placeImages } from "@/server/import/docx-convert";
import { discard, store } from "@/server/import/markdown";
import { decodePage } from "@/server/link-preview";
import { savedLocale } from "@/server/mail/locale";
import { createPage } from "@/server/pages";
import { uploadLimits } from "@/server/storage";
import { getWebClipTarget, requireTopLevel, setWebClipTarget } from "@/server/workspaces";
import { clipHtml, extractWebPage, type RecipeLabels } from "./web-clip-extract";
import { WebClipError } from "./web-clip-error";

export { WebClipError } from "./web-clip-error";

/**
 * Saving a web page into the workspace: the page at an address someone gives (the import dialog,
 * the bookmarklet and share sheet through app/share, the REST API and MCP) becomes a page of theirs
 * with its title, a link back, its main text and, when it has one, its recipe first (see
 * web-clip-extract). It goes under a page, into a database as a row (its first URL property set
 * to the address), or at the top of the workspace as a private page.
 *
 * The address is typed by a person, so the server fetches it only the way it reaches connections
 * (connections/fetch, in its `web` and `untrusted` reach): public addresses only (or hosts in
 * WEB_FETCH_ALLOWED_HOSTS, never CONNECTOR_ALLOWED_HOSTS), every redirect checked again, the
 * connection pinned to the checked address; http and https on the usual web ports. On top of that
 * a time limit for the whole save, a size limit for the page, and a count and size limit for its
 * pictures, which are copied into the workspace (a saved page doesn't load pictures from the site:
 * the site may change or vanish, and every view would tell it who is reading). No cookies or
 * credentials are sent, nothing about the person either.
 *
 * All or nothing like the imports: if writing the page fails, the page goes again with its uploads.
 */

export const WEB_CLIP_LIMITS = {
  /** Fetching the page. */
  pageTimeoutMs: 15_000,
  /** Of the page's HTML read; a longer page is read up to here. */
  pageBytes: 5 * 1024 * 1024,
  /** Pictures copied into the workspace; the rest are left out with a warning. */
  images: 20,
  /** One picture. */
  imageBytes: 5 * 1024 * 1024,
  /** Fetching all the pictures. */
  imagesTimeoutMs: 30_000,
  /** Pictures fetched at once. */
  imageConcurrency: 4,
  /** Characters of an address. */
  urlChars: 2_048,
};

const USER_AGENT = "Mozilla/5.0 (compatible; LeafdeskBot/1.0; save web page)";

/** An address as a web URL (http or https), or a WebClipError. */
export function webClipUrl(value: string): URL {
  const text = value.trim();
  if (!text || text.length > WEB_CLIP_LIMITS.urlChars) throw new WebClipError("invalidUrl", "Not a web address");
  let url: URL;
  try {
    // An address without its scheme ("example.com/a") is read as https.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new WebClipError("invalidUrl", "Not a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebClipError("invalidUrl", "Only http and https addresses");
  url.hash = "";
  return url;
}

/** A fetch error as a WebClipError. */
function fetchError(error: unknown, signal: AbortSignal): WebClipError {
  if (error instanceof WebClipError) return error;
  if (error instanceof ConnectionFetchError) return new WebClipError(error.code, error.message);
  if (signal.aborted) return new WebClipError("timeout", "Timed out");
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  if (cause?.code === "EBLOCKED") return new WebClipError("blocked", "A private address");
  return new WebClipError("unreachable", error instanceof Error ? error.message : "Unreachable");
}

/**
 * Fetches `url` through the guarded fetch: at most `maxBytes` of its body (`truncate`: the start of
 * a longer one, else a tooLarge null), with its type and where it ended up after redirects.
 */
async function fetchBody(
  url: URL,
  { accept, maxBytes, truncate, signal }: { accept: string; maxBytes: number; truncate: boolean; signal: AbortSignal },
): Promise<{ bytes: Buffer; contentType: string; url: string } | null> {
  let response: Response;
  try {
    response = await connectionFetch(url, { headers: { "user-agent": USER_AGENT, accept, "accept-language": "*" }, signal }, { web: true, untrusted: true });
  } catch (error) {
    throw fetchError(error, signal);
  }
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebClipError("httpError", `HTTP ${response.status}`, response.status);
  }
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (!truncate && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        if (!truncate) return null;
        break;
      }
    }
  } catch (error) {
    throw fetchError(error, signal);
  }
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), contentType, url: response.url || url.href };
}

/** Fetches the page at `url`: its HTML (decoded) and its address after redirects. */
export async function fetchWebPage(url: URL): Promise<{ html: string; url: string }> {
  const signal = AbortSignal.timeout(WEB_CLIP_LIMITS.pageTimeoutMs);
  const page = await fetchBody(url, {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    maxBytes: WEB_CLIP_LIMITS.pageBytes,
    truncate: true,
    signal,
  });
  if (!page || !/html|xml/.test(page.contentType)) throw new WebClipError("notHtml", `Not a web page (${page?.contentType || "no type"})`);
  return { html: decodePage(page.bytes, page.contentType), url: page.url };
}

/** The recipe words in `locale`. */
async function recipeLabels(locale: Locale): Promise<RecipeLabels> {
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages: { recipe: messages.import.web.recipe }, namespace: "recipe" });
  return {
    yield: t("yield"),
    prepTime: t("prepTime"),
    cookTime: t("cookTime"),
    totalTime: t("totalTime"),
    ingredients: t("ingredients"),
    steps: t("steps"),
  };
}

/** Where a saved page goes: under `parent` (a page, or a database for a row), else at the top. */
type Destination = { workspaceId: string; parent: { id: string; kind: "page" | "database" } | null };

async function destination(userId: string, workspaceId: string, targetId: string | null): Promise<Destination> {
  if (!targetId) {
    // Someone who can't add pages at the top (a guest, mostly) is refused before anything is fetched.
    await requireTopLevel(userId, workspaceId);
    return { workspaceId, parent: null };
  }
  let target;
  try {
    target = await requirePageAccess(userId, targetId, "edit");
  } catch (error) {
    if (error instanceof AccessError) throw new WebClipError("noAccess", "The page isn't there or isn't yours to edit");
    throw error;
  }
  if (target.archivedAt) throw new WebClipError("noAccess", "The page is in the trash");
  if (target.workspaceId !== workspaceId) throw new WebClipError("badTarget", "The page is in another workspace");
  if (target.kind !== "page" && target.kind !== "database") throw new WebClipError("badTarget", "Web pages go under a page or into a database");
  return { workspaceId, parent: { id: target.id, kind: target.kind } };
}

/**
 * Where the person last saved a web page to in the workspace, if it is still there and theirs to
 * edit; null (a private page at the top) otherwise.
 */
export async function lastWebClipTarget(userId: string, workspaceId: string): Promise<string | null> {
  const saved = await getWebClipTarget(userId, workspaceId);
  if (!saved) return null;
  return destination(userId, workspaceId, saved).then(
    (found) => found.parent?.id ?? null,
    () => null,
  );
}

/**
 * A picture's file name: the name its address gives it, with the extension of the type it came as
 * (stored files are typed by their extension), else numbered.
 */
function pictureName(url: string, index: number, contentType: string): string {
  const generic = imageName(index, contentType);
  let last = "";
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    // A malformed escape: numbered.
  }
  const stem = last.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().slice(0, 80);
  const dot = generic.lastIndexOf(".");
  return stem ? stem + (dot >= 0 ? generic.slice(dot) : "") : generic;
}

/**
 * Copies the pictures (the first WEB_CLIP_LIMITS.images) to `pageId`, a few at a time: the URL of
 * each one stored, by token. One that can't be fetched, isn't a picture pages show, or is too large
 * is left out with a warning.
 */
async function copyImages(
  userId: string,
  pageId: string,
  images: { token: string; url: string }[],
  warnings: WarningList,
  counts: { files: number },
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const chosen = images.slice(0, WEB_CLIP_LIMITS.images);
  if (images.length > chosen.length) {
    warnings.add({ code: "tooManyImages", count: images.length - chosen.length, limit: WEB_CLIP_LIMITS.images });
  }
  const signal = AbortSignal.timeout(WEB_CLIP_LIMITS.imagesTimeoutMs);
  const maxBytes = Math.min(WEB_CLIP_LIMITS.imageBytes, uploadLimits().maxFileBytes);
  let next = 0;
  const work = async () => {
    while (next < chosen.length) {
      const index = next++;
      const { token, url } = chosen[index];
      const path = pictureName(url, index + 1, "");
      try {
        const fetched = await fetchBody(new URL(url), { accept: "image/*", maxBytes, truncate: false, signal });
        if (!fetched) {
          warnings.add({ code: "fileNotStored", path, reason: "tooLarge" });
          continue;
        }
        const type = fetched.contentType.split(";")[0].trim();
        if (!isPageImage(type)) {
          warnings.add({ code: "fileNotStored", path, reason: "unsupportedType" });
          continue;
        }
        const stored = await store(userId, pageId, pictureName(url, index + 1, type), new Uint8Array(fetched.bytes), warnings, counts);
        if (stored) urls.set(token, stored);
      } catch (error) {
        if (error instanceof AccessError) throw error;
        if (!(error instanceof WebClipError)) console.error("[web-clip] couldn't copy a picture", error);
        warnings.add({ code: "fileNotStored", path, reason: "failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: WEB_CLIP_LIMITS.imageConcurrency }, work));
  return urls;
}

export type SaveWebPageInput = {
  workspaceId: string;
  url: string;
  /**
   * Where it goes: a page (saved under it) or a database (saved as its row), null for the top of
   * the workspace, undefined for where the person saved the last time (see lastWebClipTarget).
   */
  targetId?: string | null;
  /** At the top: the teamspace; null (the default) for a page only the person sees. */
  teamspaceId?: string | null;
  /** What the person had selected on the page: shown as a quote under the link. */
  quote?: string;
  /** Remember the destination as the person's choice for the next time (the app's own forms do). */
  remember?: boolean;
  /** The language of the recipe's headings; the person's own when left out. */
  locale?: string;
};

export type SavedWebPage = ImportResult & {
  page: { id: string; title: string; workspaceId: string; parentId: string | null; row: boolean };
};

/** Saves the web page at `input.url` (see above). Throws WebClipError, and AccessError for the workspace. */
export async function saveWebPage(actor: WriteActor, input: SaveWebPageInput): Promise<SavedWebPage> {
  const { userId } = actor;
  const url = webClipUrl(input.url);
  // Nothing is fetched for someone who can't save into the workspace.
  await requireMembership(userId, input.workspaceId);
  const targetId = input.targetId === undefined ? await lastWebClipTarget(userId, input.workspaceId) : input.targetId;
  const place = await destination(userId, input.workspaceId, targetId);

  const fetched = await fetchWebPage(url);
  const extracted = extractWebPage(fetched.html, fetched.url);
  const locale = isLocale(input.locale) ? input.locale : ((await savedLocale(userId).catch(() => null)) ?? DEFAULT_LOCALE);
  // Where the page is after redirects (a short link's page, say) is what the saved page points at.
  const source = fetched.url;
  const html = clipHtml(extracted, { url: source, quote: input.quote, labels: await recipeLabels(locale), locale });
  let blocks;
  try {
    ({ blocks } = await htmlBlocks(source, html, { unreadable: "badRequest", tooComplex: "docxTooComplex" }, { title: false }));
  } catch {
    throw new WebClipError("tooComplex", "The page is too large or complex to save as one page");
  }

  // A row gets the address in the database's first URL property it may see.
  const urlProperty =
    place.parent?.kind === "database" ? (await knownProperties(userId, place.parent.id)).find((p) => p.type === "url") : undefined;
  const base = {
    workspaceId: place.workspaceId,
    parentId: place.parent?.id ?? null,
    teamspaceId: place.parent ? undefined : (input.teamspaceId ?? null),
    title: extracted.title,
  };
  let created;
  try {
    created = await createPage(actor, { ...base, ...(urlProperty && { properties: { [urlProperty.id]: source } }) }, { audit: false });
  } catch (error) {
    // A URL property they may not fill in (see property-access): the row goes without it.
    if (!(error instanceof AccessError) || !urlProperty) throw error;
    created = await createPage(actor, base, { audit: false });
  }

  const warnings = new WarningList();
  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  if (place.parent?.kind === "database") counts.rows++;
  else counts.pages++;
  try {
    const sources = new Set(imageSources(blocks));
    const images = extracted.images.filter((image) => sources.has(image.token));
    const urls = await copyImages(userId, created.id, images, warnings, counts);
    const placed = placeImages(blocks, urls);
    if (placed.length) await getCollab().appendBlocks(created.id, placed, actor);
  } catch (error) {
    await discard(place.workspaceId, [created]);
    throw error;
  }

  if (input.remember) await setWebClipTarget(userId, input.workspaceId, place.parent?.id ?? null);
  const result: SavedWebPage = {
    pages: [{ id: created.id, title: extracted.title, kind: "page" }],
    created: counts,
    warnings: warnings.list,
    moreWarnings: warnings.more,
    page: { id: created.id, title: extracted.title, workspaceId: place.workspaceId, parentId: base.parentId, row: place.parent?.kind === "database" },
  };
  await recordImport(userId, place.workspaceId, result, "web");
  return result;
}
