import { randomBytes } from "node:crypto";
import {
  BlockNoteSchema,
  createBlockSpec,
  createExtension,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
  type PartialBlock,
} from "@blocknote/core";
import { CommentMark } from "@blocknote/core/comments";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import katex from "katex";
import {
  breadcrumbBlockConfig,
  calloutBlockConfig,
  footnoteConfig,
  inlineMathConfig,
  KATEX_OPTIONS,
  mathBlockConfig,
  mermaidBlockConfig,
  subpagesBlockConfig,
  tocBlockConfig,
} from "@/lib/content-blocks";
import { columnBlockSpecs, groupColumns } from "@/lib/columns";
import { finishMarkdownImport, footnoteMarkdown, plainText, prepareMarkdownExport, prepareMarkdownImport } from "@/lib/content-markdown";
import {
  carryOverMentions,
  mentionConfig,
  mentionPlainText,
  pageLinkBlockConfig,
  syncedPageBlockConfig,
  type MentionPerson,
} from "@/lib/mentions";
import {
  databaseBlockConfig,
  linkedViewBlockConfig,
  mergeReferencedBlocks,
  referenceLine,
  splitMarkdownReferences,
  isEmbedBlockType,
} from "@/lib/embed-blocks";
import { dashboardBlockConfig, restoreDashboards } from "@/lib/dashboard";
import { textScriptStyleSpecs } from "@/lib/text-scripts";
import { restoreBookmarks } from "@/lib/web-blocks";
import { collapseSyncedRegions, SYNCED_BLOCK, syncedBlockConfig, syncedBlocksIn } from "@/lib/synced-blocks";
import { webBlockServerSpecs } from "./web-blocks";

/**
 * The page body schema on the server: BlockNote's blocks plus the database blocks and the content
 * blocks (lib/content-blocks), so reading and writing documents (derived Markdown and text, MCP
 * writes, history restores, published pages) understands every block the editor can insert. The
 * editor's schema (components/page/embed-blocks.tsx) uses the same configs with React rendering.
 */

/** Server rendering of a database block: never the database itself, only a neutral marker. */
const marker = (type: string) => ({
  render: () => {
    const dom = document.createElement("div");
    dom.setAttribute("data-leafdesk-embed", type);
    return { dom };
  },
});

/**
 * An equation as KaTeX builds it: DOM nodes made one by one (no HTML string is parsed), from a
 * source KaTeX escapes, with `trust: false` so no link, image or HTML command gets through. A
 * malformed source shows as KaTeX's error text instead of failing the page.
 */
function mathElement(tag: "div" | "span", latex: string, displayMode: boolean) {
  const dom = document.createElement(tag);
  dom.setAttribute("data-leafdesk-math", displayMode ? "block" : "inline");
  if (latex.trim()) katex.render(latex, dom, { ...KATEX_OPTIONS, displayMode, throwOnError: false });
  return dom;
}

/** A "plain" block's source, as the server editor lays it out. */
function sourceElement(kind: string) {
  const dom = document.createElement("pre");
  dom.setAttribute(`data-leafdesk-${kind}`, "");
  const code = document.createElement("code");
  dom.appendChild(code);
  return { dom, contentDOM: code };
}

const contentBlockSpecs = {
  callout: createBlockSpec(calloutBlockConfig, {
    render: (block) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-leafdesk-callout", "");
      if (block.props.icon) {
        const icon = document.createElement("span");
        icon.setAttribute("data-callout-icon", "");
        icon.textContent = block.props.icon;
        dom.appendChild(icon);
      }
      const contentDOM = document.createElement("div");
      contentDOM.setAttribute("data-callout-text", "");
      dom.appendChild(contentDOM);
      return { dom, contentDOM };
    },
  })(),
  math: createBlockSpec(mathBlockConfig, {
    meta: { code: true },
    render: () => sourceElement("math"),
    toExternalHTML: (block) => ({ dom: mathElement("div", plainText(block.content), true) }),
  })(),
  // Published pages draw diagrams in the browser (see published-body.ts); elsewhere the source.
  mermaid: createBlockSpec(mermaidBlockConfig, {
    meta: { code: true },
    render: () => sourceElement("mermaid"),
    toExternalHTML: (block) => {
      const { dom, contentDOM } = sourceElement("mermaid");
      contentDOM.className = "language-mermaid";
      contentDOM.textContent = plainText(block.content);
      return { dom };
    },
  })(),
  tableOfContents: createBlockSpec(tocBlockConfig, marker("tableOfContents"))(),
  breadcrumb: createBlockSpec(breadcrumbBlockConfig, marker("breadcrumb"))(),
  subpages: createBlockSpec(subpagesBlockConfig, marker("subpages"))(),
};

const inlineMath = createInlineContentSpec(inlineMathConfig, {
  meta: { code: true },
  render: () => {
    const dom = document.createElement("span");
    dom.setAttribute("data-leafdesk-math", "inline");
    return { dom, contentDOM: dom };
  },
  toExternalHTML: (inlineContent) => ({ dom: mathElement("span", plainText(inlineContent.content), false) }),
});

/**
 * A footnote on the server: its note as the node's text. In HTML it is a mark holding the note,
 * which published pages number and list at the end (see published-body.ts).
 */
const footnote = createInlineContentSpec(footnoteConfig, {
  meta: { code: true },
  render: () => {
    const dom = document.createElement("span");
    dom.setAttribute("data-leafdesk-footnote", "");
    return { dom, contentDOM: dom };
  },
});

/**
 * A mention on the server: people and dates as their text, pages as nothing (their title isn't the
 * mention's to show). Published pages resolve mentions before serializing (see published-body.ts).
 */
const mention = createInlineContentSpec(mentionConfig, {
  render: (inlineContent) => {
    const dom = document.createElement("span");
    dom.setAttribute("data-leafdesk-mention", inlineContent.props.kind);
    dom.textContent = mentionPlainText(inlineContent.props);
    return { dom };
  },
});

export const pageSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    database: createBlockSpec(databaseBlockConfig, marker("database"))(),
    linkedView: createBlockSpec(linkedViewBlockConfig, marker("linkedView"))(),
    dashboard: createBlockSpec(dashboardBlockConfig, marker("dashboard"))(),
    ...contentBlockSpecs,
    ...webBlockServerSpecs,
    pageLink: createBlockSpec(pageLinkBlockConfig, marker("pageLink"))(),
    // Only the page's id: its body is never part of this page's text, Markdown or history.
    syncedPage: createBlockSpec(syncedPageBlockConfig, marker("syncedPage"))(),
    // Only its ids: its blocks are a fragment of the source page's document (lib/synced-blocks).
    syncedBlock: createBlockSpec(syncedBlockConfig, marker("syncedBlock"))(),
    ...columnBlockSpecs(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, inlineMath, footnote, mention },
  styleSpecs: { ...defaultStyleSpecs, ...textScriptStyleSpecs },
});

/**
 * Comments mark the text they're about. Without the mark in the schema, text carrying it would read
 * as empty (and writes would drop it), so the server knows it even though it never shows comments.
 */
const commentMarks = createExtension({ key: "commentMarks", tiptapExtensions: [CommentMark] });

export const serverEditor = ServerBlockNoteEditor.create({ schema: pageSchema, extensions: [commentMarks] });

export type PageBlock = ReturnType<typeof serverEditor.yXmlFragmentToBlocks>[number];
type PartialPageBlock = PartialBlock<typeof pageSchema.blockSchema, typeof pageSchema.inlineContentSchema, typeof pageSchema.styleSchema>;

/**
 * Markdown of a page body. Database blocks become their reference line (see lib/embed-blocks):
 * each is written as a paragraph holding a one-off token, which the Markdown serializer leaves as
 * it is, and the token is swapped for the line afterwards. Content blocks take their Markdown
 * forms the same way (see lib/content-markdown), and so do mentions and page links (lib/mentions),
 * whose links point into `workspaceId` (the page's workspace).
 */
export async function blocksToMarkdown(blocks: PageBlock[], { workspaceId }: { workspaceId?: string } = {}): Promise<string> {
  const nonce = randomBytes(6).toString("hex");
  const content = prepareMarkdownExport(blocks, nonce, { workspaceId });
  const lines: string[] = [];
  const replace = (list: PageBlock[]): PartialPageBlock[] =>
    list.flatMap((block): PartialPageBlock[] => {
      const children = block.children?.length ? replace(block.children) : [];
      if (!isEmbedBlockType(block.type)) return [{ ...block, children } as PartialPageBlock];
      const databaseId = String((block.props as { databaseId?: unknown }).databaseId ?? "");
      // Not pointed at a database yet: nothing to write.
      if (!databaseId) return children;
      lines.push(referenceLine(block.type, databaseId));
      return [{ type: "paragraph", content: `leafdesk${nonce}embed${lines.length - 1}x`, children }];
    });
  const markdown = content.finish(await serverEditor.blocksToMarkdownLossy(replace(content.blocks)));
  return markdown.replace(new RegExp(`leafdesk${nonce}embed(\\d+)x`, "g"), (_, i: string) => lines[Number(i)] ?? "");
}

export type MentionContext = {
  /**
   * The page written to: its synced blocks (sources) the Markdown leaves out stay at the end of a
   * rewrite, like inline databases, as other pages show them.
   */
  pageId?: string;
  /** People `@Name` may mention: the page's workspace. */
  people?: MentionPerson[];
  /** The app's origin: absolute links to its pages become page mentions too. */
  appUrl?: string;
};

/** Blocks for Markdown, with the content blocks' and mentions' Markdown forms (see lib/content-markdown). */
async function parseMarkdown(markdown: string, context: MentionContext): Promise<PageBlock[]> {
  const nonce = randomBytes(6).toString("hex");
  const prepared = prepareMarkdownImport(markdown, nonce, context);
  const blocks = (await serverEditor.tryParseMarkdownToBlocks(prepared.markdown)) as PageBlock[];
  return finishMarkdownImport(blocks, prepared, nonce, (inner) => parseMarkdown(inner, context), context);
}

/**
 * Blocks for Markdown written into a page (MCP, new pages), given the page's current blocks.
 * Reference lines become database blocks; see mergeReferencedBlocks for what carries over. Column
 * markers become column lists (lib/columns groupColumns), and footnotes come back with their notes
 * (lib/content-markdown footnoteMarkdown). People and dates mentioned before keep their mention's
 * identity (see carryOverMentions).
 */
export async function markdownToBlocks(
  markdown: string,
  existing: PageBlock[] = [],
  {
    keepMissingInline = true,
    carryOver = true,
    ...context
  }: {
    keepMissingInline?: boolean;
    /** False when the Markdown is added to the page (not a rewrite of it): its mentions are all new. */
    carryOver?: boolean;
  } & MentionContext = {},
): Promise<PageBlock[]> {
  // Footnotes first: their notes sit at the end, apart from the blocks that refer to them.
  const notes = footnoteMarkdown(markdown, randomBytes(6).toString("hex"));
  // A synced block's blocks are never written from Markdown: only its begin line counts.
  const parts = await Promise.all(
    splitMarkdownReferences(collapseSyncedRegions(notes.markdown)).map(async (part) =>
      "markdown" in part ? { blocks: await parseMarkdown(part.markdown, context) } : part,
    ),
  );
  const blocks = groupColumns(notes.restore(mergeReferencedBlocks(parts, existing, { keepMissingInline })));
  if (keepMissingInline && context.pageId) blocks.push(...missingSources(blocks, existing, context.pageId));
  carryOverMentions(blocks, carryOver ? existing : []);
  // A rewrite of the whole body (not an append) gets the page's bookmarks back from their link lines
  // and its dashboards from theirs; an append makes no dashboard (restoreDashboards drops the lines).
  return keepMissingInline ? restoreDashboards(restoreBookmarks(blocks, existing), existing) : restoreDashboards(blocks, []);
}

/** The page's synced blocks (sources) that `blocks` leave out, as blocks to add back. */
function missingSources(blocks: PageBlock[], existing: PageBlock[], pageId: string): PageBlock[] {
  const kept = new Set(syncedBlocksIn(blocks).map((ref) => `${ref.pageId}:${ref.syncId}`));
  const out: PageBlock[] = [];
  for (const ref of syncedBlocksIn(existing)) {
    const key = `${ref.pageId}:${ref.syncId}`;
    if (ref.pageId !== pageId || kept.has(key)) continue;
    kept.add(key);
    out.push({ type: SYNCED_BLOCK, props: { pageId: ref.pageId, syncId: ref.syncId }, children: [] } as unknown as PageBlock);
  }
  return out;
}
