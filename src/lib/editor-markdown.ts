/**
 * Markdown of blocks in the page editor (the AI assistant, voice notes), in the same form as the
 * server's (server/blocknote blocksToMarkdown and markdownToBlocks): footnotes as `[^1]` with their
 * notes at the end, equations as `$…$`, callouts, mentions and the other content blocks as
 * lib/content-markdown writes them, so what goes through Markdown comes back as it was.
 */
import { groupColumns } from "./columns";
import { finishMarkdownImport, footnoteMarkdown, prepareMarkdownExport, prepareMarkdownImport, type MdBlock } from "./content-markdown";

/** The Markdown side of an editor (the browser's answers right away, the server's in a promise). */
export type MarkdownEditor<B extends MdBlock> = {
  blocksToMarkdownLossy(blocks: never): string | Promise<string>;
  tryParseMarkdownToBlocks(markdown: string): B[] | Promise<B[]>;
};

/** A one-off token part: letters and digits only, which the Markdown serializer leaves as they are. */
const nonce = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

export async function editorBlocksToMarkdown<B extends MdBlock>(editor: MarkdownEditor<B>, blocks: B[]): Promise<string> {
  const content = prepareMarkdownExport(blocks, nonce());
  return content.finish(await editor.blocksToMarkdownLossy(content.blocks as never));
}

/** `appUrl`: the app's origin, so absolute links to its pages become page mentions too. */
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
  return groupColumns(notes.restore(await parse(notes.markdown)));
}
