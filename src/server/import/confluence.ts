import { JSDOM, VirtualConsole } from "jsdom";
import { CALLOUT_BLOCK, TOC_BLOCK } from "@/lib/content-block-names";
import { contentTypeFor } from "@/lib/files";
import { codeLanguage, emoticonText, exportPath, isPageFile, orderPages, pageTitle, panelColor, spaceName, type ConfluenceTreeNode } from "@/lib/import/confluence";
import { IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, WarningList, type ImportResult } from "@/lib/import/result";
import { EMPTY_MENTION, MENTION, newMentionId } from "@/lib/mentions";
import { requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { createPage } from "@/server/pages";
import { collectFiles, type UploadedFile } from "./archive";
import { recordImport } from "./csv";
import { DOCX_LIMITS, htmlBlocks, IMAGE_TOKEN, imageSources, isPageImage, placeImages } from "./docx-convert";
import { discard, store } from "./markdown";
import { requireTopLevelPlace } from "./place";

/**
 * Imports a Confluence space exported as HTML (a ZIP; see lib/import/confluence for its layout) as
 * pages under a page or at the top level: one page per page of the space, nested as the space's
 * index lists them (or, for pages it leaves out, as their breadcrumbs say). A space whose index
 * has one top page (its home) comes in as that page; otherwise a page named after the space holds
 * the top pages.
 *
 * Each page's content (`#main-content`) is read with the editor's HTML reader, as a Word document's
 * is (see docx-convert htmlBlocks), after the macros it can't know are rewritten into what it does:
 * info, note, tip and warning panels become callouts, the code macro a code block in its language,
 * expand a toggle, task lists to-dos, the table of contents a table of contents, emoticons emoji.
 * Links to pages of the export become mentions of the imported pages; pictures and linked
 * attachments are uploaded to the page; whatever else the export links to is left as text.
 *
 * The export is untrusted: jsdom parses each file without running scripts or loading anything,
 * the ZIP is unpacked within the import limits (server/import/archive) and each page within the
 * Word import's. All or nothing: every page is read and converted before one is created, and the
 * pages created are deleted again if a later step fails.
 */

export type ConfluenceImportInput = {
  workspaceId: string;
  /** The page the space goes under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
  files: UploadedFile[];
};

/** Links to pages and attachments of the export carry these until the pages exist (https, so the link check keeps them). */
const LINK_TOKEN = "https://confluence-import.invalid/";
/** A paragraph standing for a callout or a table of contents until the blocks are put together. */
const BLOCK_TOKEN = /^⟦leafdesk-confluence:(callout|toc):(\d+)⟧$/;

type Callout = { color: string; title: string; blocks: PageBlock[] };
type ReadPage = {
  file: string;
  title: string;
  parent: string | null;
  blocks: PageBlock[];
  /** Image tokens and attachment links by the export path they stand for. */
  images: Map<string, string>;
  files: Map<string, string>;
  /** Attachments' own file names (the export names them by id), by export path. */
  names: Map<string, string>;
};

const decoder = new TextDecoder("utf-8");

function parse(html: string) {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

/** The space's page tree from its index's list ("Available Pages"): the outermost list of links to pages. */
function indexTree(document: Document, file: string, pages: Set<string>): ConfluenceTreeNode[] {
  const pageOf = (a: Element | null | undefined) => {
    const path = exportPath(file, a?.getAttribute("href"));
    return path && pages.has(path) ? path : null;
  };
  const list = [...document.querySelectorAll("ul")].find((ul) => !ul.parentElement?.closest("ul") && [...ul.querySelectorAll(":scope > li > a, :scope > li > span > a")].some((a) => pageOf(a)));
  const read = (ul: Element): ConfluenceTreeNode[] =>
    [...ul.children]
      .filter((li) => li.tagName === "LI")
      .flatMap((li) => {
        const link = [...li.querySelectorAll("a")].find((a) => a.closest("li") === li && pageOf(a));
        const children = [...li.children].filter((child) => child.tagName === "UL").flatMap(read);
        const page = pageOf(link);
        return page ? [{ file: page, children }] : children;
      });
  return list ? read(list) : [];
}

/** Rewrites what the editor's HTML reader wouldn't understand (see the module's comment), in place. */
function rewriteMacros(document: Document, main: Element, file: string, pages: Map<string, number>, exported: Map<string, Uint8Array>, page: Pick<ReadPage, "images" | "files" | "names">, callouts: Callout[], tokens: string[]) {
  const named = (el: Element, path: string) => {
    const alias = el.getAttribute("data-linked-resource-default-alias")?.trim().replace(/[\\/]/g, "_");
    if (alias && !page.names.has(path)) page.names.set(path, alias.slice(0, 200));
  };
  const paragraph = (text: string) => {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  };
  for (const el of main.querySelectorAll("script, style, noscript, .expand-control-icon, .aui-icon, .confluence-information-macro-icon")) el.remove();
  for (const toc of main.querySelectorAll(".toc-macro, .client-side-toc-macro")) toc.replaceWith(paragraph("⟦leafdesk-confluence:toc:0⟧"));
  // Code: the macro's box with its title bar becomes the block itself.
  for (const pre of main.querySelectorAll("pre.syntaxhighlighter-pre, pre[data-syntaxhighlighter-params], .preformatted pre")) {
    const code = document.createElement("code");
    const language = codeLanguage(pre.getAttribute("data-syntaxhighlighter-params"));
    if (language) code.className = `language-${language}`;
    code.textContent = pre.textContent ?? "";
    const block = document.createElement("pre");
    block.append(code);
    (pre.closest(".code.panel, .preformatted.panel") ?? pre).replaceWith(block);
  }
  for (const expand of main.querySelectorAll(".expand-container")) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = expand.querySelector(".expand-control-text")?.textContent?.trim() || "…";
    details.append(summary);
    const content = expand.querySelector(".expand-content");
    if (content) details.append(...content.childNodes);
    expand.replaceWith(details);
  }
  for (const li of main.querySelectorAll("ul.inline-task-list > li")) {
    const box = document.createElement("input");
    box.type = "checkbox";
    if (li.classList.contains("checked")) box.setAttribute("checked", "");
    li.prepend(box);
  }
  for (const img of main.querySelectorAll("img.emoticon, img[data-emoji-id]")) {
    img.replaceWith(document.createTextNode(emoticonText(img.getAttribute("data-emoji-fallback"), img.getAttribute("alt"))));
  }
  for (const img of main.querySelectorAll("img")) {
    const path = exportPath(file, img.getAttribute("data-image-src") ?? img.getAttribute("src"));
    if (!path || !exported.has(path)) continue;
    let token = page.images.get(path);
    if (!token) {
      token = `${IMAGE_TOKEN}confluence-${page.images.size + 1}`;
      page.images.set(path, token);
    }
    named(img, path);
    img.setAttribute("src", token);
    img.removeAttribute("srcset");
  }
  for (const a of main.querySelectorAll("a[href]")) {
    const path = exportPath(file, a.getAttribute("href"));
    if (path === null) continue;
    if (a.classList.contains("confluence-userlink") || a.classList.contains("user-mention")) {
      a.replaceWith(...a.childNodes);
    } else if (pages.has(path)) {
      a.setAttribute("href", `${LINK_TOKEN}page/${pages.get(path)}`);
    } else if (exported.has(path)) {
      let token = page.files.get(path);
      if (!token) {
        token = `${LINK_TOKEN}file/${page.files.size + 1}`;
        page.files.set(path, token);
      }
      named(a, path);
      a.setAttribute("href", token);
    } else {
      tokens.push(path);
      a.replaceWith(...a.childNodes);
    }
  }
  // Panels last, innermost first, so a panel's body is read with its own panels already tokens.
  const panels = [...main.querySelectorAll(".confluence-information-macro, .panel:not(.code):not(.preformatted)")].reverse();
  return panels.map((panel) => {
    const title = (panel.querySelector(":scope > .title, :scope > p.title, :scope > .panelHeader")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const body = panel.querySelector(":scope > .confluence-information-macro-body, :scope > .panelContent") ?? panel;
    for (const header of panel.querySelectorAll(":scope > .title, :scope > p.title, :scope > .panelHeader")) header.remove();
    const html = body.innerHTML;
    const index = callouts.length;
    callouts.push({ color: panelColor(panel.className), title, blocks: [] });
    panel.replaceWith(paragraph(`⟦leafdesk-confluence:callout:${index}⟧`));
    return { index, html };
  });
}

const textOf = (block: PageBlock) =>
  Array.isArray(block.content) && block.content.length === 1 && (block.content[0] as { type?: string }).type === "text" ? String((block.content[0] as { text?: unknown }).text ?? "").trim() : "";

/** Puts callouts and tables of contents in place of the paragraphs standing for them. */
function placeTokens(blocks: PageBlock[], callouts: Callout[]): PageBlock[] {
  return blocks.flatMap((block): PageBlock[] => {
    const token = block.type === "paragraph" ? BLOCK_TOKEN.exec(textOf(block)) : null;
    if (token?.[1] === "toc") return [{ type: TOC_BLOCK, props: {}, children: [] } as unknown as PageBlock];
    if (token?.[1] === "callout") {
      const callout = callouts[Number(token[2])];
      if (!callout) return [];
      const inner = placeTokens(callout.blocks, callouts);
      const first = inner[0]?.type === "paragraph" ? inner.shift()! : null;
      return [
        {
          type: CALLOUT_BLOCK,
          props: { icon: "", backgroundColor: callout.color, ...(callout.title ? { title: callout.title } : {}) },
          content: first?.content ?? [],
          children: [...(first?.children ?? []), ...inner],
        } as unknown as PageBlock,
      ];
    }
    return [{ ...block, children: block.children?.length ? placeTokens(block.children, callouts) : block.children } as PageBlock];
  });
}

type Inline = { type?: string; href?: string; content?: unknown; text?: string };

/** Calls `fn` with each list of inline content (block text and table cells), which it may change. */
function eachInline(blocks: PageBlock[], fn: (nodes: Inline[]) => Inline[]) {
  for (const block of blocks) {
    const content = block.content as unknown;
    if (Array.isArray(content)) (block as { content: unknown }).content = fn(content as Inline[]);
    else if (content && typeof content === "object" && Array.isArray((content as { rows?: unknown }).rows)) {
      for (const row of (content as { rows: { cells: unknown[] }[] }).rows) {
        row.cells = row.cells.map((cell) => {
          if (Array.isArray(cell)) return fn(cell as Inline[]);
          const c = cell as { content?: unknown };
          return Array.isArray(c?.content) ? { ...c, content: fn(c.content as Inline[]) } : cell;
        });
      }
    }
    if (block.children?.length) eachInline(block.children, fn);
  }
}

/** Reads every page of the export, before anything is created. */
async function readExport(input: ConfluenceImportInput, warnings: WarningList) {
  const { files, skipped } = collectFiles(input.files);
  for (const s of skipped) warnings.add({ code: "skipped", path: s.path, reason: s.reason });
  const documents = new Map<string, Document>();
  for (const [path, data] of files) {
    if (!isPageFile(path) && !/(^|\/)index\.html?$/i.test(path)) continue;
    if (data.byteLength > DOCX_LIMITS.htmlBytes) {
      throw new ImportError(`“${path}” is too large to import as one page`, "docxTooComplex", { name: path });
    }
    const document = parse(decoder.decode(data));
    if (isPageFile(path) && !document.querySelector("#main-content, .wiki-content")) continue;
    documents.set(path, document);
  }
  const pageFiles = [...documents.keys()].filter(isPageFile);
  if (!pageFiles.length) throw new ImportError("The upload isn't a Confluence space exported as HTML", "badConfluence");
  if (pageFiles.length > IMPORT_LIMITS.pages - 1) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.pages} pages`, "tooManyPages", { limit: IMPORT_LIMITS.pages });
  }
  const known = new Set(pageFiles);
  const numbers = new Map(pageFiles.map((file, i) => [file, i]));

  let tree: ConfluenceTreeNode[] = [];
  let space = "";
  for (const [path, document] of documents) {
    if (isPageFile(path)) continue;
    const found = indexTree(document, path, known);
    if (found.length > tree.length) {
      tree = found;
      space = spaceName(document.title);
    }
  }

  const pages: ReadPage[] = [];
  for (const file of pageFiles) {
    const document = documents.get(file)!;
    const crumbs = [...document.querySelectorAll("#breadcrumbs a, .breadcrumbs a")]
      .map((a) => exportPath(file, a.getAttribute("href")))
      .filter((path): path is string => !!path && known.has(path) && path !== file);
    space ||= spaceName(document.title);
    const main = document.querySelector("#main-content, .wiki-content")!;
    const page: ReadPage = {
      file,
      title: pageTitle(document.querySelector("#title-text")?.textContent, document.title) || file.slice(file.lastIndexOf("/") + 1).replace(/(_\d+)?\.html?$/i, ""),
      parent: crumbs.at(-1) ?? null,
      blocks: [],
      images: new Map(),
      files: new Map(),
      names: new Map(),
    };
    const callouts: Callout[] = [];
    const missing: string[] = [];
    const panels = rewriteMacros(document, main, file, numbers, files, page, callouts, missing);
    for (const path of new Set(missing)) warnings.add({ code: "missingFile", path, page: page.title });
    const codes = { unreadable: "badConfluence", tooComplex: "docxTooComplex" } as const;
    for (const panel of panels) callouts[panel.index].blocks = (await htmlBlocks(file, panel.html, codes, { title: false })).blocks;
    page.blocks = placeTokens((await htmlBlocks(file, main.innerHTML, codes, { title: false })).blocks, callouts);
    pages.push(page);
  }
  return { pages, tree, space, files, numbers };
}

/** The path an attachment is stored and reported by: its own name in place of its id, when the export gives it. */
const nameOf = (page: ReadPage, path: string) => {
  const name = page.names.get(path);
  return name ? `${path.slice(0, path.lastIndexOf("/") + 1)}${name}` : path;
};

export async function importConfluence(actor: WriteActor, input: ConfluenceImportInput): Promise<ImportResult> {
  const { userId } = actor;
  if (!input.files.length) throw new ImportError("There is no Confluence export to import", "nothingToImport");
  let workspaceId = input.workspaceId;
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    if (parent.kind !== "page") throw new ImportError("Pages can only be imported into a page", "badRequest");
    workspaceId = parent.workspaceId;
  } else await requireTopLevelPlace(userId, workspaceId, input.teamspaceId);

  const warnings = new WarningList();
  const { pages, tree, space, files, numbers } = await readExport(input, warnings);
  const byFile = new Map(pages.map((p) => [p.file, p]));
  const order = orderPages(pages, tree);
  const tops = order.filter((p) => p.parent === null);

  const counts = { pages: 0, databases: 0, rows: 0, templates: 0, files: 0 };
  const roots: { id: string; title: string }[] = [];
  const ids = new Map<string, string>();
  try {
    // One top page (the space's home) is the space; otherwise a page named after it holds them.
    let holder: string | null = null;
    if (tops.length > 1) {
      const title = space || byFile.get(tops[0].file)!.title;
      const { id } = await createPage(actor, { workspaceId, parentId: input.parentId, teamspaceId: input.teamspaceId, title }, { audit: false });
      roots.push({ id, title });
      counts.pages++;
      holder = id;
    }
    for (const { file, parent } of order) {
      const page = byFile.get(file)!;
      const parentId = parent ? ids.get(parent)! : (holder ?? input.parentId);
      const top = !parent && !holder;
      const { id } = await createPage(
        actor,
        { workspaceId, parentId, ...(top ? { teamspaceId: input.teamspaceId } : {}), title: page.title },
        { audit: false },
      );
      if (top) roots.push({ id, title: page.title });
      ids.set(file, id);
      counts.pages++;
    }
    const pageIds = [...numbers].map(([file]) => ids.get(file)!);

    for (const page of pages) {
      const id = ids.get(page.file)!;
      const urls = new Map<string, string>();
      for (const [path, token] of page.images) {
        if (!isPageImage(contentTypeFor(null, path))) warnings.add({ code: "fileNotStored", path, reason: "unsupportedType" });
        else if (imageSources(page.blocks).includes(token)) {
          const url = await store(userId, id, nameOf(page, path), files.get(path)!, warnings, counts);
          if (url) urls.set(token, url);
        }
      }
      const links = new Map<string, string>();
      for (const [path, token] of page.files) {
        const url = await store(userId, id, nameOf(page, path), files.get(path)!, warnings, counts);
        if (url) links.set(token, url);
      }
      eachInline(page.blocks, (nodes) =>
        nodes.flatMap((node): Inline[] => {
          if (node.type !== "link" || !node.href?.startsWith(LINK_TOKEN)) return [node];
          const target = /^page\/(\d+)$/.exec(node.href.slice(LINK_TOKEN.length));
          const pageId = target ? pageIds[Number(target[1])] : undefined;
          if (pageId) return [{ type: MENTION, props: { ...EMPTY_MENTION, id: newMentionId(), kind: "page", pageId } } as Inline];
          const url = links.get(node.href);
          if (url) return [{ ...node, href: url }];
          return Array.isArray(node.content) ? (node.content as Inline[]) : [];
        }),
      );
      const blocks = placeImages(page.blocks, urls);
      if (blocks.length) await getCollab().appendBlocks(id, blocks, actor);
    }
  } catch (error) {
    await discard(workspaceId, roots);
    throw error;
  }

  const result: ImportResult = {
    pages: roots.map((r) => ({ id: r.id, title: r.title, kind: "page" as const })),
    created: counts,
    warnings: warnings.list,
    moreWarnings: warnings.more,
  };
  await recordImport(userId, workspaceId, result, "confluence");
  return result;
}
