/**
 * Files attached to the AI chat's questions (lib/chat-attachments.ts): images, which go to the
 * model as images where it takes them; PDFs, Word documents, Excel workbooks and PowerPoint
 * presentations, read to text (file-text.ts, as for search); CSV files, read as tables the chat can
 * read on in and make a database of (chat-attachment-table.ts); Markdown and text files.
 *
 * Each is an uploaded `file` of the workspace on no page, tied to the person who attached it
 * (`ai_chat_file`): only they can open it (`chatFileForOwner`, served by /api/ai/chat/files/[id]),
 * never through a page, a published page or a backup (files.ts doesn't know it), and only they can
 * attach it to a question. It counts against the workspace's storage like any upload. Once its
 * question is kept it belongs to that conversation: later questions there see it too, and it is
 * deleted with the conversation. An upload never sent goes with the day-old uploads
 * (files.purgeUnusedUploads). What is attached and read is never logged.
 */
import { Readable } from "node:stream";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { aiChatFile, file } from "@/db/schema";
import type { ChatAttachmentRecord } from "@/db/schema/ai";
import { decodeText, readCsvAttachment } from "@/lib/chat-attachment-table";
import {
  CHAT_CSV_MAX_CHARS,
  CHAT_FILE_LIMITS,
  chatFileKind,
  chatFileUrl,
  cleanAttachmentName,
  uniqueAttachmentName,
  type AttachmentProblem,
  type ChatAttachmentView,
} from "@/lib/chat-attachments";
import { cleanFileName, contentTypeFor, formatBytes } from "@/lib/files";
import type { CsvTable } from "@/lib/import/csv-parse";
import { requireMembership } from "@/server/access";
import type { AiImage } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { documentText, FILE_TEXT_LIMITS } from "@/server/file-text";
import { deleteQueued, FileError, fileObject, fileObjectColumns, queueStorageDeletion, readStored, storeFile, type FileRow, type UploadInput } from "@/server/files";

/** The most bytes a CSV file may have: its text may then still be too long (CHAT_CSV_MAX_CHARS). */
const CSV_MAX_BYTES = CHAT_CSV_MAX_CHARS * 4;

/** A CSV file the chat can't take as a table: `problem` says why. */
export class ChatFileError extends FileError {
  constructor(
    message: string,
    readonly problem: AttachmentProblem,
  ) {
    super(message, problem === "tooLarge" ? "tooLarge" : "badRequest");
  }
}

/**
 * Stores a file the person attaches to a chat question in the workspace (a member or guest there,
 * with AI on). Throws FileError: a kind the chat doesn't read ("badRequest"), larger than its limit
 * ("tooLarge"), past the workspace's storage ("quotaExceeded"); ChatFileError for a CSV file that
 * isn't a table the chat takes (empty, too many rows or columns).
 */
export async function uploadChatFile(userId: string, workspaceId: string, input: UploadInput): Promise<ChatAttachmentView> {
  await requireMembership(userId, workspaceId);
  if (!(await aiAvailable(workspaceId))) throw new FileError("AI is off for this workspace", "notAllowed");
  const name = cleanAttachmentName(cleanFileName(input.name));
  const kind = chatFileKind(contentTypeFor(input.contentType, name), name);
  if (!kind) throw new FileError("The chat reads images, PDFs, Word, Excel and PowerPoint documents, CSV, Markdown and text files", "badRequest");
  const maxBytes = kind === "image" ? CHAT_FILE_LIMITS.imageBytes : kind === "csv" ? CSV_MAX_BYTES : CHAT_FILE_LIMITS.bytes;
  if (input.declaredSize != null && input.declaredSize > maxBytes) throw new FileError(`Files attached to the chat can be at most ${formatBytes(maxBytes)}`, "tooLarge", maxBytes);
  let body = input.body;
  let table: CsvTable | null = null;
  // A CSV file is read as a table first: one the chat can't take isn't stored.
  if (kind === "csv") {
    const bytes = await readAll(body, maxBytes);
    const read = readCsvAttachment(decodeText(bytes));
    if (!read.ok) throw new ChatFileError(`The file ${name} can't be attached (${read.problem})`, read.problem);
    table = read.table;
    body = Readable.from([bytes]);
  }
  const stored = await storeFile(
    {
      workspaceId,
      pageId: null,
      uploadedBy: userId,
      record: async (tx, fileId) => void (await tx.insert(aiChatFile).values({ fileId, userId, workspaceId })),
    },
    { ...input, name, body },
    { maxBytes },
  );
  return {
    id: stored.id,
    name: stored.name,
    contentType: stored.contentType,
    size: stored.size,
    ...(table ? { rows: table.rows.length, columns: table.headers.length } : {}),
    url: chatFileUrl(stored.id),
  };
}

/** A body read whole, refused past `maxBytes`. */
async function readAll(body: UploadInput["body"], maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body instanceof Readable ? body : Readable.fromWeb(body as never)) {
    size += (chunk as Uint8Array).length;
    if (size > maxBytes) throw new FileError(`Files attached to the chat can be at most ${formatBytes(maxBytes)}`, "tooLarge", maxBytes);
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
}

/** The chat file, when `userId` attached it; null otherwise, the same way whether it is missing or someone else's. */
export async function chatFileForOwner(userId: string, fileId: string): Promise<FileRow | null> {
  const [found] = await db
    .select({ file })
    .from(file)
    .innerJoin(aiChatFile, eq(aiChatFile.fileId, file.id))
    .where(and(eq(file.id, fileId), eq(aiChatFile.userId, userId)))
    .limit(1);
  return found?.file ?? null;
}

/**
 * The person's chat files among `ids` in the workspace, in the order given: not sent yet, or (with
 * `conversationId`) sent in that conversation. With `all`, null when one of them isn't (gone,
 * someone else's, attached elsewhere); without, those that aren't are left out.
 */
export async function questionFiles(userId: string, workspaceId: string, conversationId: string | null, ids: string[], { all = true } = {}): Promise<FileRow[] | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db
    .select({ file })
    .from(file)
    .innerJoin(aiChatFile, eq(aiChatFile.fileId, file.id))
    .where(
      and(
        inArray(file.id, unique),
        eq(aiChatFile.userId, userId),
        eq(aiChatFile.workspaceId, workspaceId),
        conversationId ? or(isNull(aiChatFile.conversationId), eq(aiChatFile.conversationId, conversationId)) : isNull(aiChatFile.conversationId),
      ),
    );
  if (all && rows.length !== unique.length) return null;
  const byId = new Map(rows.map((r) => [r.file.id, r.file]));
  return unique.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The content of a file attached to the conversation, as the chat's prompt and tools take it: a
 * CSV file's table, or a document's or text file's text (`partial`: only its start was read).
 */
export type ChatFileContent = { kind: "csv"; name: string; headers: string[]; rows: string[][] } | { kind: "text"; name: string; text: string; partial: boolean };

/** What the conversation's files give the model. */
export type ConversationFiles = {
  /** The files read, oldest first, under their names in the conversation. */
  contents: ChatFileContent[];
  /** The question's own images (earlier ones only by name, in the history). */
  images: AiImage[];
  imageNames: string[];
  /** Files that gave nothing to read (a scan, a damaged or locked file, gone from storage), by name. */
  unread: string[];
};

/**
 * Reads the conversation's files for the model: `earlier` (records of earlier questions) and the
 * question's own (`records`, with `rows`, their files), each under its name in the conversation.
 * Images are read only for the question. A document is read once and kept (file-text.ts).
 */
export async function readConversationFiles(
  userId: string,
  workspaceId: string,
  conversationId: string | null,
  earlier: ChatAttachmentRecord[],
  question: { records: ChatAttachmentRecord[]; rows: FileRow[] },
): Promise<ConversationFiles> {
  const out: ConversationFiles = { contents: [], images: [], imageNames: [], unread: [] };
  const earlierText = earlier.filter((r) => chatFileKind(r.contentType, r.name) !== "image");
  const earlierRows = conversationId && earlierText.length ? await questionFiles(userId, workspaceId, conversationId, earlierText.map((r) => r.id), { all: false }) : [];
  const byId = new Map([...(earlierRows ?? []), ...question.rows].map((f) => [f.id, f]));
  const own = new Set(question.records.map((r) => r.id));
  for (const record of [...earlierText, ...question.records]) {
    const found = byId.get(record.id);
    const kind = chatFileKind(record.contentType, record.name);
    if (kind === "image") {
      if (!own.has(record.id)) continue;
      const bytes = found && found.size <= CHAT_FILE_LIMITS.imageBytes ? await readStored(found).catch(() => null) : null;
      if (bytes) {
        out.images.push({ data: bytes.toString("base64"), mimeType: found!.contentType });
        out.imageNames.push(record.name);
      } else out.unread.push(record.name);
      continue;
    }
    const content = found ? await readChatFile(found, record.name).catch(() => null) : null;
    if (content) out.contents.push(content);
    else out.unread.push(record.name);
  }
  return out;
}

/** A file's content for the chat under `name`; null when it gives nothing to read. */
export async function readChatFile(found: FileRow, name: string): Promise<ChatFileContent | null> {
  const kind = chatFileKind(found.contentType, found.name);
  if (kind === "document") {
    const read = await documentText(found);
    return read?.text ? { kind: "text", name, text: read.text, partial: read.partial } : null;
  }
  if (kind !== "csv" && kind !== "text") return null;
  const bytes = found.size <= (kind === "csv" ? CSV_MAX_BYTES : CHAT_FILE_LIMITS.bytes) ? await readStored(found) : null;
  if (!bytes) return null;
  const text = decodeText(bytes);
  if (kind === "csv") {
    const read = readCsvAttachment(text);
    return read.ok ? { kind: "csv", name, ...read.table } : null;
  }
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return null;
  return { kind: "text", name, text: clean.slice(0, FILE_TEXT_LIMITS.chars), partial: clean.length > FILE_TEXT_LIMITS.chars };
}

/**
 * The question's files as its record keeps them, named apart from the conversation's other files
 * (`taken`): a CSV file with its rows and columns, read again (null when one can't be read now).
 */
export async function attachmentRecords(files: FileRow[], taken: string[]): Promise<ChatAttachmentRecord[] | null> {
  const names = [...taken];
  const out: ChatAttachmentRecord[] = [];
  for (const f of files) {
    const name = uniqueAttachmentName(names, cleanAttachmentName(f.name));
    names.push(name);
    const record: ChatAttachmentRecord = { id: f.id, name, contentType: f.contentType, size: f.size };
    if (chatFileKind(f.contentType, f.name) === "csv") {
      const read = await readChatFile(f, name).catch(() => null);
      if (read?.kind !== "csv") return null;
      record.rows = read.rows.length;
      record.columns = read.headers.length;
    }
    out.push(record);
  }
  return out;
}

/** Ties a kept question's files to its conversation, which they are then deleted with. */
export async function keepQuestionFiles(conversationId: string, fileIds: string[]) {
  if (!fileIds.length) return;
  await db
    .update(aiChatFile)
    .set({ conversationId })
    .where(and(inArray(aiChatFile.fileId, fileIds), isNull(aiChatFile.conversationId)));
}

/** Deletes the files of these conversations, rows and stored bytes (queued, so a failure is tried again). */
export async function deleteConversationFiles(conversationIds: string[]) {
  if (!conversationIds.length) return;
  const objects = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(file)
      .where(inArray(file.id, tx.select({ id: aiChatFile.fileId }).from(aiChatFile).where(inArray(aiChatFile.conversationId, conversationIds))))
      .returning(fileObjectColumns);
    const queued = gone.map(fileObject);
    await queueStorageDeletion(tx, queued);
    return queued;
  });
  await deleteQueued(objects).catch((error) => console.error("[ai] couldn't delete a conversation's files from storage; will try again", error));
}
