import { createBlockSpecFromTiptapNode, type ExtensionFactoryInstance } from "@blocknote/core";
import { Node } from "@tiptap/core";
import { COLUMN_BLOCK, COLUMN_LIST_BLOCK } from "./columns";

/**
 * Tabs: blocks in named groups, one group shown at a time. A tab list holds one to twelve tabs, a
 * tab holds blocks and its title.
 *
 * Built like columns (lib/columns): two ProseMirror nodes BlockNote reads as blocks, shared by the
 * editor (components/page/tabs.tsx adds the tab strip) and the server (server/blocknote.ts). In the
 * BlockNote API a tab list is a block whose children are its tabs, and a tab one whose children are
 * its blocks; neither has content or text. Which tab shows is each reader's own: it is never stored,
 * so one person switching tabs switches nobody else's. Printed, exported and in Markdown every tab
 * is there, one after another under its title.
 *
 * A tab holds blocks and column lists, never another tab list, and a column holds no tab list
 * (columns hold only blocks, lib/columns), so tabs never nest and never sit in a column.
 *
 * BlockNote gives ids only to the nodes it knows (blockContainer, columnList, column), so both
 * nodes carry their own `id` attribute here; in the editor components/page/tabs.tsx gives new and
 * copied ones a fresh id.
 */

export const TAB_LIST_BLOCK = "tabList";
export const TAB_BLOCK = "tab";
/** Tabs a list may have: past a dozen the strip no longer reads at a glance. */
export const MAX_TABS = 12;
/** Longest tab title, in characters. */
export const MAX_TAB_TITLE = 80;

export const isTabBlockType = (type: unknown) => type === TAB_LIST_BLOCK || type === TAB_BLOCK;

/** A usable tab title: one line, trimmed, at most MAX_TAB_TITLE characters. */
export function tabTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE) : "";
}

function domFor(name: string, className: string, attributes: Record<string, unknown>) {
  const dom = document.createElement("div");
  dom.className = className;
  dom.setAttribute("data-node-type", name);
  for (const [attribute, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined && attribute !== "class" && attribute !== "style") dom.setAttribute(attribute, String(value));
  }
  return dom;
}

const idAttribute = {
  default: null,
  parseHTML: (element: HTMLElement) => element.getAttribute("data-id"),
  renderHTML: (attributes: Record<string, unknown>) => (attributes.id ? { "data-id": String(attributes.id) } : {}),
};

export const TabListNode = Node.create({
  name: TAB_LIST_BLOCK,
  // As a column list: a BlockNote block with an id, whose children are blocks, going where a block goes.
  group: "childContainer bnBlock blockGroupChild",
  content: "tab+",
  priority: 40,
  defining: true,
  addAttributes() {
    return { id: idAttribute };
  },
  parseHTML() {
    return [{ tag: `div[data-node-type="${TAB_LIST_BLOCK}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = domFor(TAB_LIST_BLOCK, "leafdesk-tabs", HTMLAttributes);
    return { dom, contentDOM: dom };
  },
});

export const TabNode = Node.create({
  name: TAB_BLOCK,
  group: "bnBlock childContainer",
  content: `(blockContainer | ${COLUMN_LIST_BLOCK})+`,
  priority: 40,
  defining: true,
  addAttributes() {
    return {
      id: idAttribute,
      title: {
        default: "",
        parseHTML: (element) => tabTitle(element.getAttribute("data-title")),
        renderHTML: (attributes) => (tabTitle(attributes.title) ? { "data-title": tabTitle(attributes.title) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: `div[data-node-type="${TAB_BLOCK}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = domFor(TAB_BLOCK, "leafdesk-tab", HTMLAttributes);
    return { dom, contentDOM: dom };
  },
});

/** The two block specs, from the given nodes (the editor passes its own, with the tab strip). */
export function tabBlockSpecs({
  tabList = TabListNode,
  tab = TabNode,
  extensions,
}: { tabList?: Node; tab?: Node; extensions?: ExtensionFactoryInstance[] } = {}) {
  return {
    tabList: createBlockSpecFromTiptapNode({ node: tabList, type: TAB_LIST_BLOCK, content: "none" }, {}, extensions),
    tab: createBlockSpecFromTiptapNode({ node: tab, type: TAB_BLOCK, content: "none" }, { title: { default: "" } }),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * Markdown has no tabs. They are written as HTML comments around their blocks, every tab in turn,
 * so other Markdown readers still show everything (one tab after another):
 *
 *   <!-- leafdesk:tabs -->
 *   <!-- leafdesk:tab "Overview" -->
 *   The first tab's blocks
 *   <!-- leafdesk:tab "Details" -->
 *   The second tab's blocks
 *   <!-- leafdesk:/tabs -->
 *
 * A title is a JSON string, with `<`, `>` and `-` escaped so it can't end the comment.
 */
export type TabMarker = { kind: "tabs" } | { kind: "tab"; title: string } | { kind: "end" };

export function tabMarkerLine(marker: TabMarker): string {
  if (marker.kind === "tabs") return "<!-- leafdesk:tabs -->";
  if (marker.kind === "end") return "<!-- leafdesk:/tabs -->";
  const title = tabTitle(marker.title);
  if (!title) return "<!-- leafdesk:tab -->";
  const json = JSON.stringify(title).replace(/[<>-]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<!-- leafdesk:tab ${json} -->`;
}

// The title's alternatives can't both match a character, so the regex never retries a run.
const MARKER_LINE = /^ {0,3}<!--\s*leafdesk:(tabs|tab|\/tabs)(?:\s+("(?:[^"\\]|\\.)*"))?\s*-->\s*$/;

export function parseTabMarker(line: string): TabMarker | null {
  const match = MARKER_LINE.exec(line);
  if (!match) return null;
  if (match[1] === "tabs") return { kind: "tabs" };
  if (match[1] === "/tabs") return { kind: "end" };
  let title = "";
  if (match[2]) {
    try {
      title = tabTitle(JSON.parse(match[2]));
    } catch {
      title = "";
    }
  }
  return { kind: "tab", title };
}

/** The block a marker stands for between parsing and groupTabs (see lib/columns COLUMN_MARKER_BLOCK). */
export const TAB_MARKER_BLOCK = "leafdesk:tabMarker";

type Tree = { type: string; props?: Record<string, unknown>; children?: Tree[] };

export function tabMarkerBlock<B>(marker: TabMarker): B {
  return { type: TAB_MARKER_BLOCK, props: { ...marker }, children: [] } as unknown as B;
}

const markerOf = (block: Tree): TabMarker | null => (block.type === TAB_MARKER_BLOCK ? (block.props as unknown as TabMarker) : null);

/**
 * Turns the markers left by Markdown import into tab lists, at every level. Lenient: blocks between
 * "tabs" and the first "tab" go to an untitled first tab, a missing "/tabs" closes at the end, a tab
 * without blocks gets an empty line, tabs past twelve join the twelfth, and a list without tabs is
 * just its blocks. Tabs don't nest and stay out of columns: markers inside a tab or a column are
 * dropped (their blocks stay), as are stray ones.
 */
export function groupTabs<B extends Tree>(blocks: B[]): B[] {
  const out: B[] = [];
  const strip = (block: B): B =>
    block.children?.length ? { ...block, children: (block.children as B[]).filter((child) => !markerOf(child)).map(strip) } : block;
  const walk = (block: B): B =>
    !block.children?.length ? block : block.type === COLUMN_BLOCK ? strip(block) : { ...block, children: groupTabs(block.children as B[]) };
  for (let i = 0; i < blocks.length; i++) {
    const marker = markerOf(blocks[i]);
    if (!marker) {
      out.push(walk(blocks[i]));
      continue;
    }
    if (marker.kind !== "tabs") continue;
    const tabs: { title: string; blocks: B[] }[] = [];
    for (i++; i < blocks.length; i++) {
      const inner = markerOf(blocks[i]);
      if (inner?.kind === "end") break;
      if (inner?.kind === "tab") {
        if (tabs.length < MAX_TABS) tabs.push({ title: inner.title, blocks: [] });
        continue;
      }
      // Another "tabs" inside: tabs don't nest, so it's dropped.
      if (inner) continue;
      if (!tabs.length) tabs.push({ title: "", blocks: [] });
      tabs[tabs.length - 1].blocks.push(strip(blocks[i]));
    }
    if (!tabs.length) continue;
    out.push({
      type: TAB_LIST_BLOCK,
      props: {},
      children: tabs.map((tab) => ({
        type: TAB_BLOCK,
        props: { title: tab.title },
        children: tab.blocks.length ? tab.blocks : [{ type: "paragraph", children: [] }],
      })),
    } as unknown as B);
  }
  return out;
}
