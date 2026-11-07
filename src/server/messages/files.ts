/**
 * Files sent in messages: uploaded to a channel before the message goes (`message_file` with no
 * message yet, removed after a day if never sent: files.ts `purgeUnusedUploads`), then attached to
 * it by `sendMessage`. A file of a message is read by whoever may read its channel; one not sent
 * yet only by the person who uploaded it. Deleting the message lets the file go
 * (files.ts `purgeOrphanFiles`).
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messageFile } from "@/db/schema";
import { fileUrl } from "@/lib/files";
import type { FileView } from "@/lib/message-wire";
import { sessionHeldBack } from "@/server/access";
import { storeFile, type UploadInput } from "@/server/files";
import { MessageError, requireChannel } from "./core";

const size = (value: unknown): number | null => (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 100_000 ? (value as number) : null);

/** Stores a file for a message the person is writing in `channelId`. */
export async function uploadMessageFile(
  userId: string,
  channelId: string,
  input: UploadInput,
  dimensions: { width?: unknown; height?: unknown } = {},
): Promise<FileView> {
  const { channel: row, member } = await requireChannel(userId, channelId, "write");
  if (!member) throw new MessageError("notMember");
  const width = size(dimensions.width);
  const height = width ? size(dimensions.height) : null;
  const stored = await storeFile(
    {
      workspaceId: row.workspaceId,
      pageId: null,
      uploadedBy: userId,
      record: async (tx, fileId) => void (await tx.insert(messageFile).values({ fileId, channelId: row.id, userId, width, height: height ? height : null })),
    },
    input,
  );
  return { id: stored.id, url: fileUrl(stored.id), name: stored.name, contentType: stored.contentType, size: stored.size, width, height: width ? height : null };
}

/**
 * Whether `userId` may read a message's file: true or false for a file sent in (or uploaded to) a
 * channel, null for other files, which files.ts decides on as before.
 */
export async function messageFileReadable(userId: string | null, fileId: string, workspaceId: string): Promise<boolean | null> {
  const [row] = await db.select().from(messageFile).where(eq(messageFile.fileId, fileId)).limit(1);
  if (!row) return null;
  if (!userId) return false;
  if (!row.messageId) return row.userId === userId;
  try {
    await requireChannel(userId, row.channelId);
  } catch {
    return false;
  }
  return !(await sessionHeldBack(userId, workspaceId));
}
