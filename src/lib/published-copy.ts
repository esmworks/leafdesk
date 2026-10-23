import { AGENT_CHAT_BLOCK } from "./agent-chat";
import { DASHBOARD_BLOCK, parseDashboard, serializeDashboard } from "./dashboard";
import { isEmbedBlockType } from "./embed-blocks";
import { MEETING_BLOCK, parseAttendees, serializeAttendees } from "./meetings";
import { isPageBlockType, MENTION, mentionProps, mentionText } from "./mentions";
import type { PropertyAccess } from "./property-access-rows";

/**
 * "Duplicate" on a published page copies it into another workspace (see server/site.ts). The copy
 * is rebuilt from the page's blocks, as the publication shows them, rather than carrying the stored
 * document along: a stored document keeps edit history, comments and ids that belong to the source
 * workspace. Pure: the server loads the blocks and writes the result.
 *
 * - People mentions become their text (`@Name`, as the published page shows them): the person
 *   isn't in the new workspace, and their id stays behind.
 * - Date mentions keep their date without a reminder.
 * - Page mentions, "Link to page" blocks and synced pages follow the copied pages; other pages read
 *   as the published page showed them (`outside`: a link to their public address, or plain text).
 * - Database blocks (inline databases, linked views) stay when their database was copied too, and
 *   are left out otherwise: the new workspace can't show a database of another workspace. So are
 *   dashboard widgets, and a dashboard none of whose databases was copied.
 * - Uploaded files point at the copies made in the new workspace (`fileIds`).
 */

type Json = unknown;
type Node = Record<string, Json>;

export type CopyRefs = {
  /** Source page id → copy id. */
  pageIds: ReadonlyMap<string, string>;
  /** Source file id → the copy's file id. */
  fileIds: ReadonlyMap<string, string>;
  /** Pages that weren't copied, as the published page showed them. */
  outside: ReadonlyMap<string, { text: string; href: string | null }>;
};

const FILE_PATH = /\/api\/files\/([A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])/g;

/** `text` with every uploaded file's path pointed at its copy (files without one stay). */
export function remapFilePaths(text: string, fileIds: ReadonlyMap<string, string>): string {
  return text.replace(FILE_PATH, (whole, id: string) => {
    const next = fileIds.get(id);
    return next ? `/api/files/${next}` : whole;
  });
}

const textNode = (text: string) => ({ type: "text", text, styles: {} });

function outsideInline(pageId: string, refs: CopyRefs): Json[] {
  const ref = refs.outside.get(pageId);
  if (!ref) return [];
  return ref.href ? [{ type: "link", href: ref.href, content: [textNode(ref.text)] }] : [textNode(ref.text)];
}

function copyInline(items: Json[], refs: CopyRefs): Json[] {
  return items.flatMap((item): Json[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
    const node = item as Node;
    if (node.type === MENTION) {
      const props = mentionProps(node.props);
      if (props.kind === "user") return [textNode(mentionText(props))];
      if (props.kind === "date") return [{ ...node, props: { ...props, remindAt: "" } }];
      const copy = refs.pageIds.get(props.pageId);
      return copy ? [{ ...node, props: { ...props, pageId: copy } }] : outsideInline(props.pageId, refs);
    }
    if (node.type === "link") {
      const content = Array.isArray(node.content) ? copyInline(node.content, refs) : [];
      const href = typeof node.href === "string" ? remapFilePaths(node.href, refs.fileIds) : node.href;
      return [{ ...node, href, content }];
    }
    return [node];
  });
}

function copyContent(content: Json, refs: CopyRefs): Json {
  if (Array.isArray(content)) return copyInline(content, refs);
  const table = content as { type?: string; rows?: { cells?: Json[] }[] } | null;
  if (table?.type === "tableContent" && Array.isArray(table.rows)) {
    return {
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        cells: (row.cells ?? []).map((cell) =>
          Array.isArray(cell)
            ? copyInline(cell, refs)
            : cell && typeof cell === "object"
              ? { ...cell, content: copyContent((cell as { content?: Json }).content, refs) }
              : cell,
        ),
      })),
    };
  }
  return content;
}

function copyProps(props: Json, fileIds: ReadonlyMap<string, string>): Json {
  if (!props || typeof props !== "object" || Array.isArray(props)) return props;
  return Object.fromEntries(
    Object.entries(props as Node).map(([key, value]) => [key, typeof value === "string" ? remapFilePaths(value, fileIds) : value]),
  );
}

type Block = { type: string; props?: Json; content?: Json; children?: Block[] } & Node;

/** The blocks of a copied page (see the rules above). */
export function copyPublishedBlocks<B extends Block>(blocks: B[], refs: CopyRefs): B[] {
  return blocks.flatMap((block): B[] => {
    const children = block.children?.length ? copyPublishedBlocks(block.children as B[], refs) : (block.children ?? []);
    const props = copyProps(block.props, refs.fileIds) as Node | undefined;
    if (isEmbedBlockType(block.type)) {
      const copy = refs.pageIds.get(String(props?.databaseId ?? ""));
      return copy ? [{ ...block, props: { ...props, databaseId: copy }, children }] : (children as B[]);
    }
    if (block.type === DASHBOARD_BLOCK) {
      const widgets = parseDashboard(props?.widgets).flatMap((w) => {
        const copy = refs.pageIds.get(w.databaseId);
        return copy ? [{ ...w, databaseId: copy }] : [];
      });
      return widgets.length ? [{ ...block, props: { ...props, widgets: serializeDashboard(widgets) }, children }] : (children as B[]);
    }
    // A chat with an agent of the source workspace: the copy's workspace has no such agent.
    if (block.type === AGENT_CHAT_BLOCK) return children as B[];
    // A meeting keeps what was said and written up; its people are names only in the new workspace,
    // and a recording under way there isn't one here.
    if (block.type === MEETING_BLOCK) {
      const attendees = serializeAttendees(parseAttendees(props?.attendees).map((a) => ({ id: "", name: a.name })));
      const status = props?.status === "recording" || props?.status === "summarizing" ? "done" : props?.status;
      return [{ ...block, props: { ...props, attendees, status, recorder: "", recorderName: "" }, children }];
    }
    if (isPageBlockType(block.type)) {
      const pageId = String(props?.pageId ?? "");
      const copy = refs.pageIds.get(pageId);
      if (copy) return [{ ...block, props: { ...props, pageId: copy }, children }];
      return [{ id: block.id, type: "paragraph", props: {}, content: outsideInline(pageId, refs), children } as unknown as B];
    }
    return [{ ...block, props, content: copyContent(block.content, refs), children }];
  });
}

/** Ids of the pages a block tree mentions or links to with "Link to page" or synced page blocks. */
export function mentionedPageIds(blocks: Block[]): string[] {
  const ids = new Set<string>();
  const inline = (items: Json) => {
    if (Array.isArray(items)) {
      for (const item of items) {
        const node = item as Node | null;
        if (node?.type === MENTION) {
          const props = mentionProps(node.props);
          if (props.kind === "page" && props.pageId) ids.add(props.pageId);
        } else if (node?.type === "link" && Array.isArray(node.content)) inline(node.content);
      }
      return;
    }
    const table = items as { type?: string; rows?: { cells?: Json[] }[] } | null;
    if (table?.type === "tableContent") {
      for (const row of table.rows ?? []) for (const cell of row.cells ?? []) inline(Array.isArray(cell) ? cell : (cell as { content?: Json })?.content);
    }
  };
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (isPageBlockType(block.type)) {
        const pageId = String((block.props as Node | undefined)?.pageId ?? "");
        if (pageId) ids.add(pageId);
      }
      inline(block.content);
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return [...ids];
}

/**
 * The properties anonymous visitors of a published page can't know of: those whose level for
 * everyone is `none` (property access, see lib/property-access). Published pages, sites and
 * copies made from them leave these out entirely: columns, values and the views' references.
 *
 * Checked on a row that names nobody, as a visitor is never among a row's people: working it out
 * without a row would count person property exceptions as if they could name them.
 */
export function unknownToVisitors(access: Pick<PropertyAccess, "open" | "levelOf" | "visible">, properties: { id: string }[]): Set<string> {
  if (access.open) return new Set();
  const known = new Set(access.visible(properties).map((p) => p.id));
  return new Set(
    properties.filter((p) => !known.has(p.id) || access.levelOf(p.id, { properties: {}, createdBy: null }) === "none").map((p) => p.id),
  );
}
