import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import pdfmake from "pdfmake";
import roboto from "pdfmake/fonts/Roboto.js";
import type { TFontDictionary } from "pdfmake/interfaces";
import { db } from "@/db";
import { page, type PropertyOptions } from "@/db/schema";
import { isEmbedBlockType, parseLinkedView } from "@/lib/embed-blocks";
import type { MdBlock } from "@/lib/content-markdown";
import { env } from "@/lib/env";
import { ENGLISH_COMMENT_LABELS } from "@/lib/export-comments";
import { fileIdOf } from "@/lib/files";
import { imageType } from "@/lib/letterheads";
import { pageLabel } from "@/lib/labels";
import { numberText, valueFormat } from "@/lib/number-format";
import { cellText } from "@/lib/table-clipboard";
import { requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { calloutStylesOf } from "@/server/callout-styles";
import { getCollab } from "@/server/collab/bridge";
import { assertExportAllowed, databaseViewTable, pageThreads, recordExport, type ViewExport } from "@/server/export";
import { commentExportLabels } from "@/server/export-labels";
import { fileForViewer, readStored } from "@/server/files";
import { letterheadForPdf } from "@/server/letterheads";
import { getBreadcrumbs } from "@/server/pages";
import { pdfDocument, type PdfEmbed, type PdfSection, type PdfTable } from "@/server/pdf-document";
import { liveChildren, printedEmbed, printRefs, syncedLabels } from "@/server/print";
import { publishedDatabase, publishedLoads, publishedRow, type PublishedDatabase, type PublishedProperty } from "@/server/publication";
import { printableBlocks } from "@/server/published-body";
import { expandSyncedBlocks, readerStates, syncedNotice } from "@/server/synced-blocks";

/**
 * A page as a PDF file, made on the server, in one of the workspace's letterheads (server/letterheads.ts)
 * or none: the page menu's "Export as PDF" and the AI chat's create_pdf ("Print" has the browser
 * print the print view instead). It reads the page the way the print view does (server/print.ts): as
 * `userId`, who needs view access to it, with database blocks, mentions and synced blocks as they
 * may see them, and is an export (refused while the workspace has export turned off, recorded in
 * its audit log). Pure layout is in pdf-document.ts.
 *
 * pdfmake reads nothing on its own: its URL access is shut and its file access kept to its fonts;
 * images are read here (uploads the reader may see, PNG or JPEG) and handed over as data.
 */

const FONT_DIR = /[\\/]pdfmake[\\/]fonts[\\/]Roboto[\\/][^\\/]+\.ttf$/;

/**
 * Noto Sans CJK, for Chinese, Japanese and Korean text, where the system has it: the Docker image
 * installs Debian's fonts-noto-cjk; Fedora and Alpine keep it elsewhere. Without it, such text
 * prints as empty boxes, as before.
 */
const CJK_FONT_DIRS = ["/usr/share/fonts/opentype/noto", "/usr/share/fonts/google-noto-sans-cjk-fonts", "/usr/share/fonts/noto"];
const CJK_FONT = (() => {
  for (const dir of CJK_FONT_DIRS) {
    const regular = join(dir, "NotoSansCJK-Regular.ttc");
    const bold = join(dir, "NotoSansCJK-Bold.ttc");
    if (existsSync(regular)) return { regular, bold: existsSync(bold) ? bold : regular };
  }
  return null;
})();

/** The collection's faces by the reader's language: the shapes of Han characters differ between them. */
const CJK_VARIANTS = { zh: "sc", ja: "jp", ko: "kr" } as const;
type CjkVariant = (typeof CJK_VARIANTS)[keyof typeof CJK_VARIANTS];
const cjkFamily = (variant: CjkVariant) => `NotoSansCJK${variant}`;

// A font collection's face is [file, PostScript name], which pdfmake reads though its types leave it out.
pdfmake.setFonts({
  ...roboto,
  ...(CJK_FONT
    ? Object.fromEntries(
        Object.values(CJK_VARIANTS).map((v) => {
          const normal = [CJK_FONT.regular, `NotoSansCJK${v}-Regular`];
          const bold = [CJK_FONT.bold, `NotoSansCJK${v}-Bold`];
          return [cjkFamily(v), { normal, bold, italics: normal, bolditalics: bold }];
        }),
      )
    : {}),
} as unknown as TFontDictionary);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => FONT_DIR.test(path) || (!!CJK_FONT && (path === CJK_FONT.regular || path === CJK_FONT.bold)));

/** The font family for CJK text in a PDF read in `locale`, or null when the system has none. */
export function cjkFont(locale: string): string | null {
  if (!CJK_FONT) return null;
  const language = locale.split("-")[0] as keyof typeof CJK_VARIANTS;
  return cjkFamily(CJK_VARIANTS[language] ?? "sc");
}

/** Images a PDF embeds: at most this many, each at most this big. */
const MAX_IMAGES = 30;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type PagePdf = { bytes: Buffer; title: string; workspaceId: string };

/** Lays out and draws a PDF, CJK text in the face of the reader's language unless `input` names one. */
export async function renderPdf(input: Parameters<typeof pdfDocument>[0]): Promise<Buffer> {
  const font = input.cjkFont !== undefined ? input.cjkFont : cjkFont(await readerLocale());
  return pdfmake.createPdf(pdfDocument({ ...input, cjkFont: font })).getBuffer();
}

/**
 * The page `pageId` as a PDF file, read as `userId`. `properties`: a database row's values are
 * listed under its title (as the print view does; off by default, since a document made for
 * someone else rarely means to show them). `letterhead`: one of the workspace's letterheads by id,
 * "none", or left out for its default (server/letterheads.ts). Throws AccessError when the page
 * can't be viewed, ExportError while export is off and LetterheadError for a letterhead that
 * isn't the workspace's. `comments`: the comment threads `userId` can see on the page follow the
 * body (lib/export-comments). `textScale`: the body's text bigger or smaller (pdfTextScale). `record: false` leaves the export out of the audit log, for an
 * archive of many pages that is recorded once (server/export-pdf.ts).
 */
export async function pagePdf(
  userId: string,
  pageId: string,
  {
    properties = false,
    letterhead: choice,
    comments = false,
    record = true,
    textScale = 1,
  }: { properties?: boolean; letterhead?: string; comments?: boolean; record?: boolean; textScale?: number } = {},
): Promise<PagePdf> {
  const target = await requirePageAccess(userId, pageId, "view");
  await assertExportAllowed(target.workspaceId);
  const letterhead = await letterheadForPdf(userId, target.workspaceId, choice);
  const [labels, locale] = await Promise.all([pdfLabels(), readerLocale()]);
  const parent = target.parentId ? (await db.select({ kind: page.kind }).from(page).where(eq(page.id, target.parentId)).limit(1))[0] : undefined;
  const isDatabase = target.kind === "database";
  const [content, crumbs, children, database, row] = await Promise.all([
    isDatabase ? Promise.resolve(null) : getCollab().readBlocks(target.id),
    getBreadcrumbs(userId, target.id),
    isDatabase ? Promise.resolve([]) : liveChildren(userId, target.id),
    isDatabase ? publishedDatabase(userId, target.id, { reader: userId }) : Promise.resolve(null),
    properties && parent?.kind === "database" && target.parentId ? publishedRow(target, target.parentId, userId) : Promise.resolve(null),
  ]);
  const synced = content ? await syncedLabels() : null;
  const blocks = content
    ? ((await printableBlocks(content.blocks as PageBlock[], {
        resolvePages: (ids) => printRefs(userId, ids),
        expandSynced: (list) =>
          expandSyncedBlocks(list, target.id, readerStates(userId), (state) => (state === "editable" || state === "readOnly" ? [] : syncedNotice(synced![state]))),
        calloutStyles: await calloutStylesOf(target.workspaceId),
      })) as MdBlock[])
    : [];
  const title = content?.title || target.title;
  const commentLabels = comments ? await commentExportLabels().catch(() => ENGLISH_COMMENT_LABELS) : null;
  const section: PdfSection = {
    title: pageLabel(title, labels.untitled),
    icon: target.icon,
    blocks,
    properties: row
      ? row.properties.flatMap((p) => {
          const value = valueText(p, row.values[p.id], locale);
          return value ? [{ name: p.name, value }] : [];
        })
      : [],
    database: database ? tableOf(database, labels.name, locale) : null,
    embeds: await embedsOf(userId, blocks, labels.name, locale),
    crumbs: crumbs.map((c) => pageLabel(c.title, labels.untitled)),
    children: children.map((c) => pageLabel(c.title, labels.untitled)),
    comments: commentLabels
      ? { heading: commentLabels.heading, resolved: commentLabels.resolved, threads: await pageThreads(userId, target.id, commentLabels) }
      : null,
  };
  const bytes = await renderPdf({
    title: section.title,
    sections: [section],
    images: await imagesOf(userId, blocks),
    link: (url) => (url.startsWith("/") ? `${env.appUrl}${url}` : url),
    labels,
    letterhead,
    textScale,
  });
  if (record) {
    await recordExport(userId, { workspaceId: target.workspaceId, page: { id: target.id, title: target.title }, format: "pdf", comments, pages: 1 });
  }
  return { bytes, title: section.title, workspaceId: target.workspaceId };
}

/**
 * What a view of the database `databaseId` shows (see ViewExport) as a PDF: its title, then the
 * rows as a table, in the workspace's default letterhead. Recorded as an export like the others.
 */
export async function viewPdf(userId: string, databaseId: string, view: ViewExport): Promise<PagePdf> {
  const table = await databaseViewTable(userId, databaseId, view, "pdf");
  const [letterhead, labels] = await Promise.all([letterheadForPdf(userId, table.workspaceId, undefined), pdfLabels()]);
  const title = pageLabel(table.title, labels.untitled);
  const bytes = await renderPdf({
    title,
    sections: [
      {
        title,
        blocks: [],
        properties: [],
        database: { header: table.header, rows: table.cells.map((row) => row.map((cell) => (cell === null ? "" : String(cell)))) },
        embeds: new Map(),
        crumbs: [],
        children: [],
      },
    ],
    images: new Map(),
    link: (url) => (url.startsWith("/") ? `${env.appUrl}${url}` : url),
    labels,
    letterhead,
  });
  return { bytes, title, workspaceId: table.workspaceId };
}

/** The texts a PDF prints, in the reader's language (English outside a request). */
async function pdfLabels() {
  try {
    const [tc, tp, tpub] = await Promise.all([getTranslations("common"), getTranslations("page.print"), getTranslations("publish")]);
    return { untitled: tc("untitled"), unavailable: tp("embedUnavailable"), name: tpub("name") };
  } catch {
    return { untitled: "Untitled", unavailable: "This database isn't available to you.", name: "Name" };
  }
}

/** The reader's language, for numbers (English outside a request). */
async function readerLocale(): Promise<string> {
  try {
    return await getLocale();
  } catch {
    return "en";
  }
}

/** A value as text, numbers in their format and the reader's locale; "" when empty. */
function valueText(property: PublishedProperty, value: unknown, locale: string): string {
  const shown = cellText({ ...property, options: property.options as PropertyOptions }, value, {
    titleOf: new Map(),
    nameOf: new Map(),
    fileText: (f) => f.name,
  });
  if (shown === null) return "";
  return typeof shown === "number" ? numberText(shown, locale, valueFormat(property)) : shown;
}

function tableOf(table: PublishedDatabase, nameLabel: string, locale: string): PdfTable {
  return {
    header: [nameLabel, ...table.properties.map((p) => p.name)],
    rows: table.rows.map((r) => [r.title, ...table.properties.map((p) => valueText(p, r.properties[p.id], locale))]),
  };
}

/** Every block of the tree, columns and nested blocks included. */
function* allBlocks(blocks: MdBlock[]): Generator<MdBlock> {
  for (const block of blocks) {
    yield block;
    if (block.children?.length) yield* allBlocks(block.children);
  }
}

/** The databases the body's database blocks show, as the reader may see them, by block id. */
async function embedsOf(userId: string, blocks: MdBlock[], nameLabel: string, locale: string): Promise<Map<string, PdfEmbed>> {
  const out = new Map<string, PdfEmbed>();
  const loads = publishedLoads();
  for (const block of allBlocks(blocks)) {
    if (!block.id || !isEmbedBlockType(block.type)) continue;
    const databaseId = String(block.props?.databaseId ?? "");
    if (!databaseId) continue;
    const linked = block.type === "linkedView" ? parseLinkedView(block.props?.view) : undefined;
    const embed = await printedEmbed(userId, databaseId, linked ? { linked } : {}, loads);
    if (embed) out.set(block.id, { title: linked?.hideTitle ? null : embed.title, table: tableOf(embed.table, nameLabel, locale) });
  }
  return out;
}

/** The images the body shows that `userId` may read, PNG or JPEG, as data URLs by their url. */
async function imagesOf(userId: string, blocks: MdBlock[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const block of allBlocks(blocks)) {
    if (block.type !== "image" || out.size >= MAX_IMAGES) continue;
    const url = typeof block.props?.url === "string" ? block.props.url : "";
    const id = fileIdOf(url);
    if (!id || out.has(url)) continue;
    const found = await fileForViewer(userId, id);
    if (!found || found.size > MAX_IMAGE_BYTES) continue;
    const bytes = await readStored(found);
    const type = bytes ? imageType(bytes) : null;
    if (bytes && type) out.set(url, `data:${type};base64,${bytes.toString("base64")}`);
  }
  return out;
}
