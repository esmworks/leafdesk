"use client";

import { createFileBlockConfig, fileParse } from "@blocknote/core";
import { createReactBlockSpec, FileBlockWrapper } from "@blocknote/react";
import { pdfFileId, spreadsheetFileId } from "@/lib/files";
import { IMPORT_SPREADSHEET_EVENT, type ImportSpreadsheetDetail } from "@/lib/import-spreadsheet-event";
import { useEmbedHost } from "./database-embed";
import { PdfViewer } from "./pdf-viewer";
import { SpreadsheetViewer } from "./spreadsheet-viewer";

/** Opens the import dialog with a workbook page `pageId` shows (the sidebar listens). */
function convertSpreadsheet(file: File, pageId: string) {
  window.dispatchEvent(new CustomEvent<ImportSpreadsheetDetail>(IMPORT_SPREADSHEET_EVENT, { detail: { file, pageId } }));
}

/**
 * BlockNote's file block with two additions: an uploaded PDF shows in place (see PdfViewer), and
 * so do an uploaded Excel workbook's cells (see SpreadsheetViewer), which an editor can turn into
 * a database. The config is BlockNote's own, so documents, the server schema (which keeps the
 * default block) and the Markdown export (a link) are unchanged; any other file still shows its
 * name.
 */
export const FileBlock = createReactBlockSpec(createFileBlockConfig, {
  meta: { fileBlockAccept: ["*/*"] },
  parse: fileParse(),
  render: function FileBlockView(props) {
    const { url, name } = props.block.props;
    // The page the block is in, and whether it may be edited now (it follows a lock as it changes).
    const host = useEmbedHost();
    const pdf = pdfFileId(url, name);
    const spreadsheet = pdf ? null : spreadsheetFileId(url, name);
    return (
      <FileBlockWrapper {...props}>
        {pdf ? (
          <PdfViewer fileId={pdf} name={name} />
        ) : spreadsheet ? (
          <SpreadsheetViewer fileId={spreadsheet} name={name} onConvert={host?.editable ? (file) => convertSpreadsheet(file, host.pageId) : undefined} />
        ) : undefined}
      </FileBlockWrapper>
    );
  },
  // As BlockNote's: a link to the file, with its caption.
  toExternalHTML: ({ block }) => {
    if (!block.props.url) return <p>{block.props.name}</p>;
    const link = <a href={block.props.url}>{block.props.name || block.props.url}</a>;
    return block.props.caption ? (
      <div>
        {link}
        <p>{block.props.caption}</p>
      </div>
    ) : (
      link
    );
  },
});
