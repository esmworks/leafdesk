"use client";

import { fileParse } from "@blocknote/core";
import { createReactBlockSpec, FileBlockWrapper } from "@blocknote/react";
import { File as FileIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, type ReactNode } from "react";
import { fileIdOf, fileUrl, pdfFileId, spreadsheetFileId } from "@/lib/files";
import { IMPORT_SPREADSHEET_EVENT, type ImportSpreadsheetDetail } from "@/lib/import-spreadsheet-event";
import { fileBlockConfig, mediaWidth } from "@/lib/media-blocks";
import { useEmbedHost } from "./database-embed";
import { PdfViewer } from "./pdf-viewer";
import { SpreadsheetViewer } from "./spreadsheet-viewer";
import { MediaResizeHandle } from "./web-blocks";
import type { PageEditor } from "./embed-blocks";

/** Opens the import dialog with a workbook page `pageId` shows (the sidebar listens). */
function convertSpreadsheet(file: File, pageId: string) {
  window.dispatchEvent(new CustomEvent<ImportSpreadsheetDetail>(IMPORT_SPREADSHEET_EVENT, { detail: { file, pageId } }));
}

/**
 * BlockNote's file block with two additions: an uploaded PDF shows in place (see PdfViewer), and
 * so do an uploaded Excel workbook's cells (see SpreadsheetViewer), which an editor can turn into
 * a database. The config is BlockNote's own, so documents, the server schema (which keeps the
 * default block) and the Markdown export (a link) are unchanged; any other file still shows its
 * name, which for an uploaded file opens it in the file viewer (see page/editor-files.tsx).
 *
 * The block may be aligned (lib/media-blocks), and a file shown in place made narrower by
 * dragging its end edge.
 */
export const FileBlock = createReactBlockSpec(fileBlockConfig, {
  meta: { fileBlockAccept: ["*/*"] },
  parse: fileParse(),
  render: function FileBlockView(props) {
    const { url, name } = props.block.props;
    // The page the block is in, and whether it may be edited now (it follows a lock as it changes).
    const host = useEmbedHost();
    const pdf = pdfFileId(url, name);
    const spreadsheet = pdf ? null : spreadsheetFileId(url, name);
    const uploaded = pdf || spreadsheet ? null : fileIdOf(url);
    return (
      <FileBlockWrapper {...(props as unknown as Parameters<typeof FileBlockWrapper>[0])}>
        {pdf ? (
          <InPlaceBox editor={props.editor as unknown as PageEditor} blockId={props.block.id} stored={props.block.props.width} canEdit={Boolean(host?.editable)}>
            <PdfViewer fileId={pdf} name={name} />
          </InPlaceBox>
        ) : spreadsheet ? (
          <InPlaceBox editor={props.editor as unknown as PageEditor} blockId={props.block.id} stored={props.block.props.width} canEdit={Boolean(host?.editable)}>
            <SpreadsheetViewer fileId={spreadsheet} name={name} onConvert={host?.editable ? (file) => convertSpreadsheet(file, host.pageId) : undefined} />
          </InPlaceBox>
        ) : uploaded && url.trim().startsWith("/") ? (
          <ViewableFileName url={fileUrl(uploaded)} name={name} />
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

/** An uploaded file's name as BlockNote shows a file's, as a button that opens it in the file viewer. */
function ViewableFileName({ url, name }: { url: string; name: string }) {
  const t = useTranslations("page.viewer");
  return (
    <button
      type="button"
      className="bn-file-name-with-icon m-0 w-full appearance-none border-0 bg-transparent text-start text-inherit"
      contentEditable={false}
      draggable={false}
      data-file-view={url}
      data-file-name={name}
      title={t("view", { name })}
    >
      <span className="bn-file-icon">
        <FileIcon size={22} strokeWidth={1.5} aria-hidden />
      </span>
      <span className="bn-file-name">{name}</span>
    </button>
  );
}

/** A file shown in place, as wide as the block says, with the handle that changes it. */
function InPlaceBox({
  editor,
  blockId,
  stored,
  canEdit,
  children,
}: {
  editor: PageEditor;
  blockId: string;
  stored: unknown;
  canEdit: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("page.viewer");
  const box = useRef<HTMLDivElement>(null);
  // The width while the edge is dragged; undefined when not dragging.
  const [dragWidth, setDragWidth] = useState<number | null | undefined>(undefined);
  const width = dragWidth === undefined ? mediaWidth(stored) : dragWidth;
  return (
    <div ref={box} data-media-box="" className="group/bookmark relative min-w-0 max-w-full" style={{ width: width ? `${width}%` : "100%" }}>
      {children}
      {canEdit && editor.isEditable && (
        <MediaResizeHandle
          card={box}
          label={t("resize")}
          onDrag={setDragWidth}
          onDone={(next) => {
            setDragWidth(undefined);
            if (next !== mediaWidth(stored) && editor.getBlock(blockId)) editor.updateBlock(blockId, { props: { width: next ?? 0 } });
          }}
        />
      )}
    </div>
  );
}
