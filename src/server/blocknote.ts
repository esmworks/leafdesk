import { isBuiltinIcon, readBuiltinIcon } from "@/lib/icon-value";
import { BUILTIN_ICONS } from "@/lib/builtin-icons-data";
import { ICON_COLOR_HEX } from "@/lib/builtin-icon-svg";
import { commentPreviewBlockConfig } from "@/lib/comment-refs";
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
import { columnBlockSpecs } from "@/lib/columns";
import { quoteBlockSpec } from "@/lib/quote-block";
import { finishMarkdownImport, plainText, prepareMarkdownExport, prepareMarkdownImport } from "@/lib/content-markdown";
import {
  mentionConfig,
  mentionPlainText,
  pageLinkBlockConfig,
  syncedPageBlockConfig,
  type MentionPerson,
} from "@/lib/mentions";
import { databaseBlockConfig, linkedViewBlockConfig, referenceLine, isEmbedBlockType } from "@/lib/embed-blocks";
import { dashboardBlockConfig } from "@/lib/dashboard";
import { agentChatBlockConfig } from "@/lib/agent-chat";
import { buttonBlockConfig, buttonColor, cleanButtonLabel } from "@/lib/buttons";
import { meetingBlockConfig, meetingProps, parseAttendees, parseTakeaways } from "@/lib/meetings";
import { markdownToPageBlocks } from "@/lib/page-markdown";
import { textScriptStyleSpecs } from "@/lib/text-scripts";
import { syncedBlockConfig } from "@/lib/synced-blocks";
import { linkedImageSpec } from "@/lib/image-links";
import { alignedAudioSpec, serverFileSpec } from "@/lib/media-blocks";
import { suggestionMarks } from "@/lib/suggestion-marks";
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
  // A styled callout is drawn from its own props: published pages and the print view write the
  // style's look into them first (lib/callout-styles applyCalloutStyles). A title goes above the
  // text, as text.
  callout: createBlockSpec(calloutBlockConfig, {
    render: (block) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-leafdesk-callout", "");
      const drawn = iconElement(block.props.icon);
      if (drawn) {
        const icon = document.createElement("span");
        icon.setAttribute("data-callout-icon", "");
        icon.append(drawn);
        dom.appendChild(icon);
      }
      const contentDOM = document.createElement("div");
      contentDOM.setAttribute("data-callout-text", "");
      if (block.props.title) {
        const body = document.createElement("div");
        body.setAttribute("data-callout-body", "");
        const title = document.createElement("div");
        title.setAttribute("data-callout-title", "");
        title.textContent = block.props.title;
        body.append(title, contentDOM);
        dom.appendChild(body);
      } else {
        dom.appendChild(contentDOM);
      }
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

/**
 * A button on the server (published pages, the print view, HTML exports): its label, disabled, in
 * its color (`opt-*` from globals.css, a name checked against the palette).
 */
function buttonElement(props: { label?: unknown; icon?: unknown; color?: unknown }) {
  const dom = document.createElement("p");
  dom.setAttribute("data-leafdesk-button", "");
  const color = buttonColor(props.color);
  if (color) dom.setAttribute("data-button-color", color);
  const button = document.createElement("button");
  button.setAttribute("type", "button");
  button.setAttribute("disabled", "");
  if (color) button.setAttribute("class", `opt-${color}`);
  const icon = iconElement(props.icon);
  const label = cleanButtonLabel(props.label);
  if (icon) button.append(icon, ...(label ? [" "] : []));
  if (label) button.append(label);
  dom.appendChild(button);
  return { dom };
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * An icon field's value in server HTML: an emoji as text, a built-in icon drawn as SVG in its color
 * (the stylesheet's `--icon-*` where there is one, the light color otherwise); nothing else.
 */
function iconElement(value: unknown): Node | null {
  if (typeof value !== "string" || !value) return null;
  if (!isBuiltinIcon(value)) return document.createTextNode(value);
  const icon = readBuiltinIcon(value);
  const node = icon && BUILTIN_ICONS[icon.name];
  if (!icon || !node) return null;
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, attr] of Object.entries({
    viewBox: "0 0 24 24",
    width: "1em",
    height: "1em",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    "data-builtin-icon": icon.name,
  })) {
    svg.setAttribute(name, attr);
  }
  if (icon.color) svg.setAttribute("style", `color: var(--icon-${icon.color}, ${ICON_COLOR_HEX[icon.color]}); vertical-align: -0.125em`);
  else svg.setAttribute("style", "vertical-align: -0.125em");
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(SVG, tag);
    for (const [name, attr] of Object.entries(attrs)) child.setAttribute(name, String(attr));
    svg.appendChild(child);
  }
  return svg;
}

/**
 * A meeting on the server: its title, who came, and its takeaways as plain HTML, which published
 * pages, the print view and HTML exports show. The transcript stays in the app (and in the page's
 * Markdown).
 */
function meetingElement(raw: Record<string, unknown>) {
  const props = meetingProps(raw);
  const dom = document.createElement("div");
  dom.setAttribute("data-leafdesk-meeting", "");
  const title = document.createElement("h3");
  title.textContent = props.title.trim() || "Meeting";
  dom.appendChild(title);
  const attendees = parseAttendees(props.attendees);
  if (attendees.length) {
    const who = document.createElement("p");
    who.textContent = attendees.map((a) => a.name).join(", ");
    dom.appendChild(who);
  }
  const sections = [
    ["Summary", props.summary],
    ["Decisions", props.decisions],
    ["Action items", props.actions],
  ] as const;
  for (const [label, lines] of sections) {
    const items = parseTakeaways(lines);
    if (!items.length) continue;
    const heading = document.createElement("h4");
    heading.textContent = label;
    const list = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item.assignee ? `${item.assignee}: ${item.text}` : item.text;
      list.appendChild(li);
    }
    dom.append(heading, list);
  }
  return { dom };
}

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
    // Quotes in the text's size or large (lib/quote-block).
    quote: quoteBlockSpec(),
    // Images may link to a web address or a page (lib/image-links).
    image: linkedImageSpec(),
    // Files and audio may be aligned, and a file shown in place made narrower (lib/media-blocks).
    file: serverFileSpec(),
    audio: alignedAudioSpec(),
    database: createBlockSpec(databaseBlockConfig, marker("database"))(),
    linkedView: createBlockSpec(linkedViewBlockConfig, marker("linkedView"))(),
    dashboard: createBlockSpec(dashboardBlockConfig, marker("dashboard"))(),
    ...contentBlockSpecs,
    ...webBlockServerSpecs,
    pageLink: createBlockSpec(pageLinkBlockConfig, marker("pageLink"))(),
    // Only its ids: what a reader sees of the thread is worked out for them (server/comment-refs).
    commentPreview: createBlockSpec(commentPreviewBlockConfig, marker("commentPreview"))(),
    // Only the page's id: its body is never part of this page's text, Markdown or history.
    syncedPage: createBlockSpec(syncedPageBlockConfig, marker("syncedPage"))(),
    // Only its ids: its blocks are a fragment of the source page's document (lib/synced-blocks).
    syncedBlock: createBlockSpec(syncedBlockConfig, marker("syncedBlock"))(),
    // Only the agent's and the chat's ids: what is said in it is each reader's own.
    agentChat: createBlockSpec(agentChatBlockConfig, marker("agentChat"))(),
    // Its label as a button that does nothing: what it does runs only in the app (server/buttons.ts).
    button: createBlockSpec(buttonBlockConfig, { render: (block) => buttonElement(block.props) })(),
    // Everything in its props (lib/meetings); its Markdown is its region, transcript included.
    meeting: createBlockSpec(meetingBlockConfig, { render: (block) => meetingElement(block.props) })(),
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

// Suggested edits (lib/suggestions) too, for the same reason.
export const serverEditor = ServerBlockNoteEditor.create({ schema: pageSchema, extensions: [commentMarks, suggestionMarks] });

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
  // The same steps as the Markdown source view's preview (lib/page-markdown).
  return markdownToPageBlocks(markdown, (part) => parseMarkdown(part, context), existing, {
    keepMissingInline,
    carryOver,
    pageId: context.pageId,
    nonce: () => randomBytes(6).toString("hex"),
  });
}
