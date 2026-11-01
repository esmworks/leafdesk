/**
 * Where a message's attachment is read (app/api/mail/attachment) and what it is served as. Pure:
 * the thread view builds the file viewer's addresses here, the route decides the type here.
 */

const PDF_START = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * The type an attachment is served as: its own, except a PDF sent as plain bytes
 * (`application/octet-stream`, as many mail programs send one), which its name and its first
 * bytes both have to say is a PDF.
 */
export function attachmentType(file: { name: string; contentType: string; data: Uint8Array }): string {
  const type = file.contentType.split(";")[0].trim().toLowerCase();
  if (type !== "application/octet-stream" || !/\.pdf$/i.test(file.name.trim())) return file.contentType;
  return PDF_START.every((byte, i) => file.data[i] === byte) ? "application/pdf" : file.contentType;
}

/** The address of a message's attachment, by the message's id in the index and the file's part. */
export function attachmentUrl(messageId: string, part: string, extra: "view=pdf" | "download=1" | null = null) {
  return `/api/mail/attachment?m=${encodeURIComponent(messageId)}&p=${encodeURIComponent(part)}${extra ? `&${extra}` : ""}`;
}

/**
 * An attachment as the file viewer (components/file-viewer) opens it. Without its size: the one the
 * mail server lists is the encoded part's, larger than the file.
 */
export function attachmentForViewer(messageId: string, file: { part: string; name: string; contentType: string }) {
  return {
    url: attachmentUrl(messageId, file.part),
    name: file.name,
    type: file.contentType,
    download: attachmentUrl(messageId, file.part, "download=1"),
    elsewhere: {
      pdf: attachmentUrl(messageId, file.part, "view=pdf"),
      docx: `/api/mail/attachment/preview?m=${encodeURIComponent(messageId)}&p=${encodeURIComponent(file.part)}`,
    },
  };
}
