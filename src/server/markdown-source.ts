import { createHash } from "node:crypto";
import * as Y from "yjs";
import { env } from "@/lib/env";
import { markdownLosses, type MarkdownLoss } from "@/lib/markdown-source";
import type { MentionPerson } from "@/lib/mentions";
import { assertPageUnlocked } from "@/lib/page-lock";
import { SYNCED_BLOCK } from "@/lib/synced-blocks";
import { requirePageAccess } from "@/server/access";
import { blocksToMarkdown, markdownToBlocks, serverEditor, type PageBlock } from "@/server/blocknote";
import { getCollab, type BodyWrite, type WriteActor } from "@/server/collab/bridge";
import { mentionablePeople } from "@/server/mentions";

/**
 * A page body as Markdown to edit as text (components/page/markdown-source.tsx), and its save.
 * The Markdown is the export and MCP dialect (lib/content-markdown), read from the page's live
 * document, not the stored `content_markdown` (which lags behind open editors by seconds).
 */

export type MarkdownSource = {
  markdown: string;
  /** The body's version the Markdown was read at (CollabService.pageVersion): a save expects it. */
  version: string;
  /** What any save from Markdown drops of the page as it is (lib/markdown-source markdownLosses). */
  losses: MarkdownLoss[];
  /** The body's blocks as stored (synced blocks without their blocks), for the preview to merge with. */
  blocks: unknown[];
  /** People `@Name` mentions, as a save reads them. */
  people: MentionPerson[];
};

/** Not a page whose body can be edited as Markdown: a database, or one in the trash. */
export class MarkdownSourceError extends Error {
  constructor(readonly code: "database" | "trashed") {
    super(code === "database" ? "Databases have no body to edit as Markdown" : "The page is in the trash");
    this.name = "MarkdownSourceError";
  }
}

/** As CollabService.pageVersion hashes the body's Markdown. */
const versionOf = (markdown: string) => createHash("sha256").update(markdown).digest("hex").slice(0, 16);

/** Synced blocks without their blocks: the body as its document holds it, and as writes find it. */
function storedBlocks(blocks: PageBlock[]): PageBlock[] {
  return blocks.map((block) => ({
    ...block,
    children: block.type === SYNCED_BLOCK ? [] : storedBlocks(block.children ?? []),
  })) as PageBlock[];
}

async function editablePage(userId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "edit");
  if (found.kind === "database") throw new MarkdownSourceError("database");
  if (found.archivedAt) throw new MarkdownSourceError("trashed");
  return found;
}

export async function readMarkdownSource(userId: string, pageId: string): Promise<MarkdownSource> {
  const found = await editablePage(userId, pageId);
  const collab = getCollab();
  let read: { blocks: PageBlock[]; markdown: string; version: string } | null = null;
  // The version is read before the body, so an edit in between can only make a save see a conflict
  // that isn't one, never miss one. Read again (a few times) while the two disagree.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await collab.pageVersion(pageId);
    const { blocks } = await collab.readBlocks(pageId, { synced: true });
    const markdown = (await blocksToMarkdown(blocks as PageBlock[], { workspaceId: found.workspaceId })).trim();
    read = { blocks: blocks as PageBlock[], markdown, version: before };
    if (versionOf(markdown) === before) break;
  }
  const { blocks, markdown, version } = read!;
  const body = storedBlocks(blocks);
  const people = await mentionablePeople(pageId);
  // What a save of this very Markdown would store, against the body as it is: through a document as
  // the write goes, so props the Markdown doesn't set read as their defaults, as they would be.
  const roundTrip = await markdownToBlocks(markdown, body, { pageId, people, appUrl: env.appUrl });
  const doc = new Y.Doc();
  let stored: PageBlock[];
  try {
    const fragment = doc.getXmlFragment("roundTrip");
    serverEditor.blocksToYXmlFragment(roundTrip, fragment);
    stored = serverEditor.yXmlFragmentToBlocks(fragment);
  } finally {
    doc.destroy();
  }
  return { markdown, version, losses: markdownLosses(body, storedBlocks(stored)), blocks: body, people };
}

/**
 * Writes the body from `markdown`, only while it still has `expectedVersion`: otherwise nothing is
 * written and the result says `conflict`, with the body's version now (a save expecting that one
 * writes over the other changes). The page is saved to its history first. Inline databases,
 * synced blocks, bookmarks, dashboards and mentions carry over as for MCP writes
 * (server/blocknote markdownToBlocks), and comments stay on the text they're about.
 */
export async function saveMarkdownSource(actor: WriteActor, pageId: string, markdown: string, expectedVersion: string): Promise<BodyWrite> {
  const found = await editablePage(actor.userId, pageId);
  assertPageUnlocked(found);
  const write = await getCollab().replaceContent(pageId, markdown, actor, "before_markdown_edit", { expectedVersion });
  // A write with an expected version always reports one.
  return write!;
}
