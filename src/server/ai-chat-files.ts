/**
 * Files attached to the AI chat's questions: images, which go to the model as images where it
 * takes them, and PDFs, Word documents, Excel workbooks, CSV, Markdown and text files, which are
 * read to text (file-text.ts, as for search) and go with the question under their names.
 *
 * Each is an uploaded `file` of the workspace on no page, tied to the person who attached it
 * (`ai_chat_file`): only they can open it (`chatFileForOwner`, served by /api/ai/chat/files/[id]),
 * never through a page, a published page or a backup (files.ts doesn't know it), and only they can
 * attach it to a question. It counts against the workspace's storage like any upload. Once its
 * question is kept it belongs to that conversation and is deleted with it; an upload never sent goes
 * with the day-old uploads (files.purgeUnusedUploads). What is attached and read is never logged.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { aiChatFile, file } from "@/db/schema";
import { CHAT_FILE_LIMITS, chatFileKind, chatFileUrl, type ChatAttachmentRecord, type ChatAttachmentView } from "@/lib/ai-chat";
import { cleanFileName, contentTypeFor, formatBytes } from "@/lib/files";
import { requireMembership } from "@/server/access";
import type { AiImage } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { documentText, FILE_TEXT_LIMITS } from "@/server/file-text";
import { deleteQueued, FileError, fileObject, fileObjectColumns, queueStorageDeletion, readStored, storeFile, type FileRow, type UploadInput } from "@/server/files";

/**
 * Stores a file the person attaches to a chat question in the workspace (a member or guest there,
 * with AI on). Throws FileError: a kind the chat doesn't read ("badRequest"), larger than its limit
 * ("tooLarge"), past the workspace's storage ("quotaExceeded").
 */
export async function uploadChatFile(userId: string, workspaceId: string, input: UploadInput): Promise<ChatAttachmentView> {
  await requireMembership(userId, workspaceId);
  if (!(await aiAvailable(workspaceId))) throw new FileError("AI is off for this workspace", "notAllowed");
  const name = cleanFileName(input.name);
  const kind = chatFileKind(contentTypeFor(input.contentType, name), name);
  if (!kind) throw new FileError("The chat reads images, PDFs, Word and Excel documents, CSV, Markdown and text files", "badRequest");
  const maxBytes = kind === "image" ? CHAT_FILE_LIMITS.imageBytes : CHAT_FILE_LIMITS.bytes;
  if (input.declaredSize != null && input.declaredSize > maxBytes) throw new FileError(`Files attached to the chat can be at most ${formatBytes(maxBytes)}`, "tooLarge", maxBytes);
  const stored = await storeFile(
    {
      workspaceId,
      pageId: null,
      uploadedBy: userId,
      record: async (tx, fileId) => void (await tx.insert(aiChatFile).values({ fileId, userId, workspaceId })),
    },
    { ...input, name },
    { maxBytes },
  );
  return { id: stored.id, name: stored.name, contentType: stored.contentType, size: stored.size, url: chatFileUrl(stored.id) };
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
 * The files a question attaches, in the order given: the person's own in the workspace, not sent yet
 * or sent before in this conversation. Null when one of them isn't (gone, someone else's).
 */
export async function questionFiles(userId: string, workspaceId: string, conversationId: string | null, ids: string[]): Promise<FileRow[] | null> {
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
  if (rows.length !== unique.length) return null;
  const byId = new Map(rows.map((r) => [r.file.id, r.file]));
  return unique.map((id) => byId.get(id)!);
}

/** What a question's files give the model: the text of each document (under its name), and the images. */
export type QuestionFileContent = {
  /** The documents' texts, each cut to its share of `room`; empty without any. */
  documents: { name: string; text: string; partial: boolean }[];
  images: AiImage[];
  /** Documents that gave no text (a scan, a damaged or locked file), by name. */
  unread: string[];
};

/**
 * Reads a question's files for the model within `room` characters, shared between the documents.
 * A document is read once and kept (file-text.ts); text files are read as UTF-8.
 */
export async function readQuestionFiles(files: FileRow[], room: number): Promise<QuestionFileContent> {
  const out: QuestionFileContent = { documents: [], images: [], unread: [] };
  const texts: { name: string; text: string; partial: boolean }[] = [];
  for (const found of files) {
    const kind = chatFileKind(found.contentType, found.name);
    if (kind === "image") {
      const bytes = found.size <= CHAT_FILE_LIMITS.imageBytes ? await readStored(found) : null;
      if (bytes) out.images.push({ data: bytes.toString("base64"), mimeType: found.contentType });
      else out.unread.push(found.name);
      continue;
    }
    if (kind === "document") {
      const read = await documentText(found).catch(() => null);
      if (read) texts.push({ name: found.name, text: read.text, partial: read.partial });
      else out.unread.push(found.name);
      continue;
    }
    const bytes = found.size <= CHAT_FILE_LIMITS.bytes ? await readStored(found) : null;
    const text = bytes ? new TextDecoder("utf-8").decode(bytes).replace(/\r\n?/g, "\n").trim() : "";
    if (text) texts.push({ name: found.name, text: text.slice(0, FILE_TEXT_LIMITS.chars), partial: text.length > FILE_TEXT_LIMITS.chars });
    else out.unread.push(found.name);
  }
  // Each document gets an equal share of the room, and what a shorter one leaves goes to the rest.
  let left = Math.max(0, room);
  texts.sort((a, b) => a.text.length - b.text.length);
  for (const [i, doc] of texts.entries()) {
    const share = Math.floor(left / (texts.length - i));
    const cut = doc.text.length > share;
    const text = cut ? doc.text.slice(0, Math.max(0, share)) : doc.text;
    left -= text.length;
    out.documents.push({ name: doc.name, text, partial: doc.partial || cut });
  }
  const order = new Map(files.map((f, i) => [f.name, i]));
  out.documents.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return out;
}

/** The files as a question's record keeps them. */
export const attachmentRecords = (files: FileRow[]): ChatAttachmentRecord[] => files.map((f) => ({ id: f.id, name: f.name, contentType: f.contentType, size: f.size }));

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
