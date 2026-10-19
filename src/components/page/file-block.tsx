"use client";

import { createFileBlockConfig, fileParse } from "@blocknote/core";
import { createReactBlockSpec, FileBlockWrapper } from "@blocknote/react";
import { pdfFileId, spreadsheetFileId } from "@/lib/files";
import { IMPORT_SPREADSHEET_EVENT, type ImportSpreadsheetDetail } from "@/lib/import-spreadsheet-event";
import { PdfViewer } from "./pdf-viewer";
import { SpreadsheetViewer } from "./spreadsheet-viewer";

/** Opens the import dialog with a workbook the page shows (the sidebar listens). */
function convertSpreadsheet(file: File) {
  window.dispatchEvent(new CustomEvent<ImportSpreadsheetDetail>(IMPORT_SPREADSHEET_EVENT, { detail: { file } }));
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
    const pdf = pdfFileId(url, name);
    const spreadsheet = pdf ? null : spreadsheetFileId(url, name);
    return (
      <FileBlockWrapper {...props}>
        {pdf ? (
          <PdfViewer fileId={pdf} name={name} />
        ) : spreadsheet ? (
          <SpreadsheetViewer fileId={spreadsheet} name={name} onConvert={props.editor.isEditable ? convertSpreadsheet : undefined} />
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
