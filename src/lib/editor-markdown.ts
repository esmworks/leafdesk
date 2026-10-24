/**
 * Markdown of blocks in the page editor (the AI assistant, voice notes), in the same form as the
 * server's (server/blocknote blocksToMarkdown and markdownToBlocks): footnotes as `[^1]` with their
 * notes at the end, equations as `$…$`, callouts, mentions and the other content blocks as
 * lib/content-markdown writes them, so what goes through Markdown comes back as it was.
 */
import { groupColumns } from "./columns";
import { restoreDashboards } from "./dashboard";
import { restoreMeetings } from "./meetings";
import { restoreButtons } from "./buttons";
import { finishMarkdownImport, footnoteMarkdown, prepareMarkdownExport, prepareMarkdownImport, type MdBlock } from "./content-markdown";
import type { MentionPerson } from "./mentions";
import { markdownToPageBlocks } from "./page-markdown";

/** The Markdown side of an editor (the browser's answers right away, the server's in a promise). */
export type MarkdownEditor<B extends MdBlock> = {
  blocksToMarkdownLossy(blocks: never): string | Promise<string>;
  tryParseMarkdownToBlocks(markdown: string): B[] | Promise<B[]>;
};

/**
 * A one-off token part: letters and digits only, which the Markdown serializer leaves as they are
 * (from getRandomValues, which pages served over plain http have too).
 */
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `pageTitle`: the titles of mentioned pages the browser knows, so links to them say which page they are. */
export async function editorBlocksToMarkdown<B extends MdBlock>(
  editor: MarkdownEditor<B>,
  blocks: B[],
  { pageTitle }: { pageTitle?: (pageId: string) => string | undefined } = {},
): Promise<string> {
  const content = prepareMarkdownExport(blocks, nonce(), { pageTitle });
  return content.finish(await editor.blocksToMarkdownLossy(content.blocks as never));
}

/**
 * Blocks to add to the page for Markdown. `appUrl`: the app's origin, so absolute links to its
 * pages become page mentions too. Dashboard lines make nothing and meeting regions plain blocks, as
 * when Markdown is added to a page on the server: a dashboard or a meeting lives in one place.
 */
export async function editorMarkdownToBlocks<B extends MdBlock>(
  editor: MarkdownEditor<B>,
  markdown: string,
  { appUrl }: { appUrl?: string } = {},
): Promise<B[]> {
  // Footnotes first, over the whole Markdown: their notes sit at the end, apart from the blocks
  // (and callouts, which are read on their own) that refer to them.
  const notes = footnoteMarkdown(markdown, nonce());
  const parse = async (part: string): Promise<B[]> => {
    const id = nonce();
    const prepared = prepareMarkdownImport(part, id, { appUrl });
    const blocks = await editor.tryParseMarkdownToBlocks(prepared.markdown);
    return finishMarkdownImport(blocks, prepared, id, parse, { appUrl });
  };
  return restoreButtons(restoreMeetings(restoreDashboards(groupColumns(notes.restore(await parse(notes.markdown))), []), []), []);
}

/**
 * The blocks a write of `markdown` over the whole page body makes, given its blocks now
 * (`existing`): as the server's markdownToBlocks makes them for MCP and the Markdown source view's
 * save (lib/page-markdown), with the same people for `@Name`. The source view's preview.
 */
export async function editorMarkdownToPageBlocks<B extends MdBlock>(
  editor: MarkdownEditor<B>,
  markdown: string,
  existing: B[],
  { appUrl, people, pageId }: { appUrl?: string; people?: MentionPerson[]; pageId?: string } = {},
): Promise<B[]> {
  const parse = async (part: string): Promise<B[]> => {
    const id = nonce();
    const prepared = prepareMarkdownImport(part, id, { appUrl });
    const blocks = await editor.tryParseMarkdownToBlocks(prepared.markdown);
    return finishMarkdownImport(blocks, prepared, id, parse, { appUrl, people });
  };
  return markdownToPageBlocks(markdown, parse, existing, { keepMissingInline: true, carryOver: true, pageId, nonce });
}
