import {
  audioParse,
  audioRender,
  audioToExternalHTML,
  createAudioBlockConfig,
  createBlockSpec,
  createFileBlockConfig,
  defaultProps,
  fileParse,
} from "@blocknote/core";

/**
 * File and audio blocks with an alignment, as images and videos have: BlockNote's blocks with
 * `textAlignment` (left, center or right; "left" is where the text starts, see globals.css) and,
 * for a file shown in place (a PDF or a workbook), a `width` in percent of the column (0 for all of
 * it, see mediaWidth), dragged from its edge like a bookmark's. Shared by the editor
 * (components/page/file-block.tsx, embed-blocks.tsx) and the server (server/blocknote.ts), whose
 * schemas must agree on the props or the side that doesn't know one drops it.
 *
 * Bookmarks and embeds (lib/web-blocks) carry the same two props.
 */

export { ALIGNABLE_MEDIA, MEDIA_ALIGNMENTS, MIN_MEDIA_WIDTH, mediaAlignment, mediaWidth, type MediaAlignment } from "./media-placement";

const fileBase = createFileBlockConfig();
export const fileBlockConfig = {
  ...fileBase,
  propSchema: { ...fileBase.propSchema, textAlignment: defaultProps.textAlignment, width: { default: 0 as number } },
} as const;

const audioBase = createAudioBlockConfig({});
export const audioBlockConfig = {
  ...audioBase,
  propSchema: { ...audioBase.propSchema, textAlignment: defaultProps.textAlignment },
} as const;

/** The audio block with its alignment: BlockNote's own otherwise. */
export const alignedAudioSpec = createBlockSpec(audioBlockConfig, {
  meta: { fileBlockAccept: ["audio/*"] },
  parse: audioParse(),
  render: (block, editor) => audioRender()(block as never, editor as never),
  toExternalHTML: (block, editor) => audioToExternalHTML()(block as never, editor as never),
  runsBefore: ["file"],
});

/**
 * The file block on the server: its HTML is BlockNote's (a link to the file, with its caption).
 * The editor draws it itself (components/page/file-block.tsx) with the same config.
 */
export const serverFileSpec = createBlockSpec(fileBlockConfig, {
  meta: { fileBlockAccept: ["*/*"] },
  parse: fileParse(),
  render: (block) => {
    const dom = document.createElement("div");
    dom.className = "bn-file-block-content-wrapper";
    dom.textContent = block.props.name || block.props.url;
    return { dom };
  },
  toExternalHTML: (block) => {
    if (!block.props.url) return { dom: document.createElement("embed") };
    const link = document.createElement("a");
    link.href = block.props.url;
    link.textContent = block.props.name || block.props.url;
    if (!block.props.caption) return { dom: link };
    const dom = document.createElement("div");
    const caption = document.createElement("p");
    caption.textContent = block.props.caption;
    dom.append(link, caption);
    return { dom };
  },
});
